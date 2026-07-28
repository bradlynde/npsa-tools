// server/connectors/salesforce.js
//
// Pulls Salesforce into the dashboard on a schedule, from inside this app.
//
// This replaces the push model (a Zap per object, firing one webhook per record,
// plus a static JSON snapshot re-run by hand). Push can only ever tell us what
// changed; it can never tell us what is *true*, which is why the dashboard kept
// drifting from Salesforce and needed snapshot-boundary guards to stop reconcile
// deleting live records.
//
// A pull knows the whole truth at once. Every run asks Salesforce for the complete
// current set, upserts it, and deletes anything Salesforce no longer has. The id
// list is seconds old rather than a hand-exported file, so it IS authoritative
// through "now" — no covers_through, no protect_created_after, no drift class.
//
// Each source is one module with one credential. Google Search Console and ads
// spend land here the same way, next to this file, rather than as more Zaps.
//
// Disabled and harmless without credentials: the sync simply never runs and the
// rest of the app is untouched.
//
// Auth is the JWT bearer flow, not a refresh token. Salesforce now forces refresh
// token rotation on new External Client Apps (the setting is checked and locked —
// "to change this required setting, contact Support"), which invalidates the old
// token on every refresh. A refresh token parked in an env var therefore works
// exactly once and then fails silently on the next scheduled run. JWT bearer has
// no refresh token to rotate: the server signs a short-lived assertion with a
// private key and trades it for an access token whenever it needs one.
//
// Env:
//   SF_CLIENT_ID              External Client App consumer key
//   SF_USERNAME               Salesforce username the sync runs as
//   SF_PRIVATE_KEY            RSA private key, PEM. Literal newlines or \n both work.
//   SF_LOGIN_URL              default https://login.salesforce.com
//   SF_API_VERSION            default v60.0
//   SF_WON_STAGE              default 'Won - Data Migrated to 2012 Processes'
//   SF_WINS_SINCE             default 2024-10-01 (company started on security grants)
//   SF_SYNC_INTERVAL_MINUTES  default 360 (every 6 hours)

import express from 'express';
import { createSign } from 'node:crypto';
import { recordWin, recordApplication, rebuildBookingWins } from '../marketing.js';

const DEFAULT_STAGE = 'Won - Data Migrated to 2012 Processes';
const DEFAULT_SINCE = '2024-10-01';

// A run that would wipe out more than half the table is treated as a bad pull
// (partial page, permissions change, wrong stage name) rather than as news. The
// upserts still land; only the deletion is held back, and the run is flagged.
const MAX_PRUNE_FRACTION = 0.5;

export const salesforceConfigured = () =>
  Boolean(process.env.SF_CLIENT_ID && process.env.SF_USERNAME && process.env.SF_PRIVATE_KEY);

const loginUrl = () => (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/+$/, '');
const apiVersion = () => process.env.SF_API_VERSION || 'v60.0';

// SOQL date literals are bare (no quotes), so a malformed env value would be a
// syntax error at query time. Fall back rather than fail the whole sync.
const winsSince = () => {
  const v = (process.env.SF_WINS_SINCE || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_SINCE;
};

// ─────────────────────────────────────────────────────────────
// Auth — OAuth2 JWT bearer flow
// Nothing here is stored between runs. Every token request builds and signs a
// fresh assertion, so there is no long-lived credential in the database or the
// environment that Salesforce can rotate out from under us — only the private
// key, which Salesforce never sees and never changes.
//
// Salesforce does not return expires_in on this grant, so the access token is
// cached for a fixed window and any 401 clears it and retries once (which also
// covers a session being killed early).
// ─────────────────────────────────────────────────────────────
const TOKEN_TTL_MS = 30 * 60 * 1000;
// Salesforce rejects an assertion whose exp is more than 5 minutes out. Three
// minutes leaves room for clock skew between Railway and Salesforce in both
// directions without ever tripping that ceiling.
const ASSERTION_TTL_S = 180;

let _token = { value: null, instanceUrl: null, at: 0 };

const b64url = input =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Railway (and most dashboards) round-trip a pasted PEM with escaped newlines.
// Accept either form so a working key never looks like a broken one.
const privateKey = () => {
  const raw = (process.env.SF_PRIVATE_KEY || '').trim();
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
};

function buildAssertion() {
  const claims = {
    iss: process.env.SF_CLIENT_ID,          // consumer key
    sub: process.env.SF_USERNAME,           // the user the sync acts as
    aud: loginUrl(),                        // must match the org it authenticates against
    exp: Math.floor(Date.now() / 1000) + ASSERTION_TTL_S,
  };
  const signingInput =
    `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey(), 'base64url')}`;
}

async function getToken(force = false) {
  if (!force && _token.value && Date.now() - _token.at < TOKEN_TTL_MS) return _token;

  let assertion;
  try {
    assertion = buildAssertion();
  } catch (err) {
    // A malformed PEM fails here rather than at the API, where it would surface
    // as an opaque 400 from Salesforce.
    throw new Error(`Salesforce JWT signing failed — check SF_PRIVATE_KEY is a full PEM RSA private key: ${err.message}`);
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch(`${loginUrl()}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || 'no access_token';
    // The two failures worth naming, because the raw text is famously unhelpful:
    // 'user hasn't approved this consumer' means the user is not pre-authorized
    // on the app, and 'invalid_app_access' means the profile/permission set is
    // not assigned. Neither is a key problem, which is where people look first.
    throw new Error(`Salesforce auth failed (${res.status}): ${detail}`);
  }
  _token = { value: json.access_token, instanceUrl: (json.instance_url || '').replace(/\/+$/, ''), at: Date.now() };
  return _token;
}

async function apiGet(pathOrUrl, retried = false) {
  const tok = await getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${tok.instanceUrl}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.value}` } });
  if (res.status === 401 && !retried) {
    await getToken(true);
    return apiGet(pathOrUrl, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Salesforce API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Run a SOQL query to completion. Salesforce pages at 2000 records; following
// nextRecordsUrl is what makes "the complete current set" actually complete —
// a half-followed pull is exactly the partial data the prune guard protects against.
async function soql(query) {
  const out = [];
  let next = `/services/data/${apiVersion()}/query?q=${encodeURIComponent(query)}`;
  while (next) {
    const page = await apiGet(next);
    out.push(...(page.records || []));
    next = page.done ? null : page.nextRecordsUrl;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Schema — one row per sync attempt, success or failure.
// This is what lets the dashboard show its own freshness instead of asking
// someone to take its word for it.
// ─────────────────────────────────────────────────────────────
export async function ensureSyncSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id           SERIAL PRIMARY KEY,
      source       TEXT NOT NULL,
      started_at   TIMESTAMPTZ DEFAULT NOW(),
      finished_at  TIMESTAMPTZ,
      ok           BOOLEAN,
      rows_seen    INTEGER DEFAULT 0,
      rows_removed INTEGER DEFAULT 0,
      note         TEXT,
      error        TEXT
    );
  `).catch(err => console.error('sync_runs schema error:', err.message));
  await pool.query(
    `CREATE INDEX IF NOT EXISTS sync_runs_source_started ON sync_runs (source, started_at DESC);`
  ).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Prune — delete what Salesforce no longer has.
// Safe here in a way it never was from a static file, because `ids` came from
// Salesforce moments ago. Two refusals remain, for a bad pull rather than a stale one.
// ─────────────────────────────────────────────────────────────
async function pruneToSet(pool, table, idColumn, ids) {
  if (!ids.length) return { removed: 0, removed_ids: [], note: 'empty pull — nothing deleted' };
  const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*)::int AS total FROM ${table}`);
  const { rows: [{ doomed }] } = await pool.query(
    `SELECT COUNT(*)::int AS doomed FROM ${table} WHERE NOT (${idColumn} = ANY($1))`, [ids]);
  if (total > 0 && doomed > total * MAX_PRUNE_FRACTION) {
    return { removed: 0, removed_ids: [],
      note: `refused to delete ${doomed} of ${total} rows (over ${MAX_PRUNE_FRACTION * 100}% — treating as a bad pull)` };
  }
  const { rows } = await pool.query(
    `DELETE FROM ${table} WHERE NOT (${idColumn} = ANY($1)) RETURNING ${idColumn} AS id`, [ids]);
  return { removed: rows.length, removed_ids: rows.map(r => r.id), note: null };
}

// ─────────────────────────────────────────────────────────────
// Appliers — everything that happens once we hold the complete current set.
//
// Deliberately separate from how the set was obtained. This app pulls when it
// has API access, and is delivered the same set by a scheduled Zap when it does
// not (Salesforce Professional Edition sells REST API access as an add-on, but
// grants it to certified partners like Zapier, so the Zap can read an org our
// own app is refused by). Both routes converge here, which means the upserts,
// the prune, the safety rails and the run record are identical either way —
// there is no second implementation to drift.
// ─────────────────────────────────────────────────────────────

// Zero records is not a real state for this business, so it means a broken query,
// a renamed stage, or a permissions change. Never let it empty the table.
const refuseIfEmpty = (records, what) => {
  if (!Array.isArray(records) || !records.length) {
    throw new Error(`received 0 ${what} — refusing to sync`);
  }
};

export async function applyWins(pool, records) {
  refuseIfEmpty(records, 'won opportunities');
  for (const w of records) await recordWin(pool, w);
  const prune = await pruneToSet(pool, 'sf_wins', 'opportunity_id',
    records.map(w => String(w.opportunity_id)));
  // Keep the funnel view equal to the win store after any removal.
  await rebuildBookingWins(pool);
  return { rows_seen: records.length, ...prune };
}

export async function applyApplications(pool, records) {
  refuseIfEmpty(records, 'applications');
  for (const a of records) await recordApplication(pool, a);
  const prune = await pruneToSet(pool, 'sf_applications', 'application_id',
    records.map(a => String(a.application_id)));
  return { rows_seen: records.length, ...prune };
}

export const APPLIERS = { salesforce_wins: applyWins, salesforce_applications: applyApplications };

// ─────────────────────────────────────────────────────────────
// Pull sources — used only when this app has its own API access.
// ─────────────────────────────────────────────────────────────
async function syncWins(pool) {
  const stage = process.env.SF_WON_STAGE || DEFAULT_STAGE;
  const records = await soql(
    `SELECT Id, Account.Name, Account.Website, EST_TCV__c, CloseDate
       FROM Opportunity
      WHERE StageName = '${stage.replace(/'/g, "\\'")}'
        AND CloseDate >= ${winsSince()}`
  );
  return applyWins(pool, records.map(r => ({
    opportunity_id: r.Id,
    organization: r.Account?.Name || null,
    domain: r.Account?.Website || null,
    amount: r.EST_TCV__c ?? 0,
    close_date: r.CloseDate || null,
  })));
}

async function syncApplications(pool) {
  // Applicaiton_Status__c is misspelled in Salesforce — that is the real API name.
  const records = await soql(
    `SELECT Id, Name, Account__c, Account__r.Name, Grant_Program__c, State__c,
            Applicaiton_Status__c, Total_Amount_Requested__c,
            Actual_Amount_Awarded__c, Maximum_Award_Amount__c
       FROM Applications__c`
  );
  return applyApplications(pool, records.map(r => ({
    application_id: r.Id,
    name: r.Name || null,
    organization: r.Account__r?.Name || null,
    account_id: r.Account__c || null,
    grant_program: r.Grant_Program__c || null,
    state: r.State__c || null,
    status: r.Applicaiton_Status__c || null,
    amount_requested: r.Total_Amount_Requested__c ?? 0,
    amount_awarded: r.Actual_Amount_Awarded__c ?? 0,
    max_award: r.Maximum_Award_Amount__c ?? 0,
  })));
}

const SOURCES = {
  salesforce_wins: syncWins,
  salesforce_applications: syncApplications,
};

// ─────────────────────────────────────────────────────────────
// Runner — one sync_runs row per source per attempt, always written, so a
// failure is as visible on the dashboard as a success.
// ─────────────────────────────────────────────────────────────
export async function runSource(pool, source, task) {
  const { rows: [run] } = await pool.query(
    `INSERT INTO sync_runs (source) VALUES ($1) RETURNING id, started_at`, [source]);
  try {
    const result = await task();
    await pool.query(
      `UPDATE sync_runs SET finished_at = NOW(), ok = TRUE, rows_seen = $2, rows_removed = $3, note = $4
         WHERE id = $1`,
      [run.id, result.rows_seen, result.removed, result.note]);
    if (result.note) console.warn(`[sync:${source}] ${result.note}`);
    console.log(`[sync:${source}] ok — ${result.rows_seen} seen, ${result.removed} removed`);
    return { source, ok: true, ...result };
  } catch (err) {
    await pool.query(
      `UPDATE sync_runs SET finished_at = NOW(), ok = FALSE, error = $2 WHERE id = $1`,
      [run.id, err.message]);
    console.error(`[sync:${source}] failed — ${err.message}`);
    return { source, ok: false, error: err.message };
  }
}

let _running = false;
let _schemaReady = null;

// Sources run in sequence, not parallel: they share one Salesforce API budget and
// one Postgres pool, and nothing here is time-critical.
export async function runSalesforceSync(pool) {
  if (!salesforceConfigured()) return { ok: false, error: 'Salesforce connector not configured' };
  if (_running) return { ok: false, error: 'a sync is already running' };
  // A manual kick can arrive before the fire-and-forget schema call has landed,
  // and every run's first act is to write a sync_runs row.
  _schemaReady = _schemaReady || ensureSyncSchema(pool);
  await _schemaReady;
  _running = true;
  try {
    const results = [];
    for (const source of Object.keys(SOURCES)) {
      results.push(await runSource(pool, source, () => SOURCES[source](pool)));
    }
    return { ok: results.every(r => r.ok), results };
  } finally {
    _running = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────
export function registerSalesforceConnector(app, pool) {
  if (!pool) return;
  _schemaReady = _schemaReady || ensureSyncSchema(pool);

  // Freshness, for the dashboard strip. Unguarded (read-only, no record data) and
  // always present, so the strip can report "not configured" rather than nothing.
  app.get('/api/marketing/sync/status', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (source) source, started_at, finished_at, ok, rows_seen, rows_removed, note, error
          FROM sync_runs
         ORDER BY source, started_at DESC`);
      // pull_configured says only whether THIS app can query Salesforce itself.
      // It is not the same question as "is the dashboard current" — a scheduled Zap
      // delivering to /sync/push keeps everything fresh with pull_configured false.
      res.json({ configured: salesforceConfigured(), pull_configured: salesforceConfigured(), runs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delivered full sync — a scheduled Zap queries Salesforce and POSTs the whole
  // current set in ONE request:
  //   { source: 'salesforce_wins' | 'salesforce_applications', records: [...] }
  //
  // One request, not one per record. That distinction is the whole point: looping
  // ~240 records nightly through Zapier costs thousands of tasks a month, while
  // this costs three (query, format, POST). The trade is that Zapier must send the
  // COMPLETE set each time, because anything absent is treated as deleted — same
  // contract the pull has, and the same safety rails apply to both.
  //
  // This payload outgrows express's 100kb default as the record count rises, so the
  // host app raises the limit for this path (see server/index.js — it must be done
  // there, ahead of the general parser, for the limit to take effect). The parser
  // here is a no-op when that has already run, and the correct limit when this
  // connector is mounted somewhere that has not.
  app.post('/api/marketing/sync/push', express.json({ limit: '10mb' }), async (req, res) => {
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const source = req.body?.source;
    const records = req.body?.records;
    if (!APPLIERS[source]) {
      return res.status(400).json({ error: `source must be one of: ${Object.keys(APPLIERS).join(', ')}` });
    }
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'records must be an array (the complete current set for this source)' });
    }
    _schemaReady = _schemaReady || ensureSyncSchema(pool);
    await _schemaReady;
    // Recorded as a sync_runs row exactly like a pull, so the freshness strip and
    // the failure history work identically no matter which transport delivered it.
    const result = await runSource(pool, source, () => APPLIERS[source](pool, records));
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Manual kick — same shared secret as the ingest endpoints.
  app.post('/api/marketing/sync/salesforce', async (req, res) => {
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.json(await runSalesforceSync(pool));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  if (!salesforceConfigured()) {
    console.log('[sync] Salesforce connector idle — set SF_CLIENT_ID / SF_USERNAME / SF_PRIVATE_KEY to enable');
    return;
  }

  const minutes = Number(process.env.SF_SYNC_INTERVAL_MINUTES) || 360;
  // A short delay keeps the sync off the boot path, so a Salesforce outage can
  // never slow or block the app coming up.
  setTimeout(() => { runSalesforceSync(pool).catch(e => console.error('[sync] startup run failed:', e.message)); }, 30_000);
  setInterval(() => { runSalesforceSync(pool).catch(e => console.error('[sync] scheduled run failed:', e.message)); }, minutes * 60_000);
  console.log(`[sync] Salesforce connector active — every ${minutes} minutes`);
}
