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
//   SF_FINANCIALS_SINCE       default 2024-11-01 (where "All Sec Financials Only" starts)
//   SF_SYNC_INTERVAL_MINUTES  default 360 (every 6 hours)
//
// Financial field API names, all overridable because this org has three misspelled
// ones already and a wrong guess returns zero rows:
//   SF_FINANCIAL_OBJECT / _AMOUNT_FIELD / _UPFRONT_FIELD / _IMPL_FIELD
//   SF_FINANCIAL_PURPOSE_FIELD / _OPPORTUNITY_FIELD

import express from 'express';
import { createSign } from 'node:crypto';
import { recordWin, recordFinancial, recordApplication, rebuildBookingWins } from '../marketing.js';
import { zapSecretOk } from '../api-gate.js';

const DEFAULT_STAGE = 'Won - Data Migrated to 2012 Processes';
const DEFAULT_SINCE = '2024-10-01';
const DEFAULT_FINANCIALS_SINCE = '2024-11-01';

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
const dateFloor = (raw, fallback) => {
  const v = (raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
};
const winsSince = () => dateFloor(process.env.SF_WINS_SINCE, DEFAULT_SINCE);
// The "All Sec Financials Only" report starts here; anything earlier predates the
// security grant business. Kept separate from the wins floor, which is a month older.
const financialsSince = () => dateFloor(process.env.SF_FINANCIALS_SINCE, DEFAULT_FINANCIALS_SINCE);

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

export async function applyFinancials(pool, records) {
  refuseIfEmpty(records, 'financial records');
  for (const f of records) await recordFinancial(pool, f);
  const prune = await pruneToSet(pool, 'sf_financials', 'financial_id',
    records.map(f => String(f.financial_id)));
  return { rows_seen: records.length, ...prune };
}

/**
 * Reads a Salesforce field however the transport chose to present it.
 *
 * A relationship field is `Opportunity__r.StageName` in the API's own JSON, but
 * anything that flattens on the way here renames it — `Opportunity__r StageName`,
 * `Opportunity__r__StageName`, `Opportunity__rStageName`. Which one arrives is a
 * property of the tool in the middle, not of Salesforce, and it is not worth a
 * deploy to find out: accept all of them and let the echo endpoint say which it was.
 */
const sfField = (rec, path) => {
  const parts = path.split('.');
  const nested = parts.reduce((o, k) => (o == null ? undefined : o[k]), rec);
  const candidates = [nested, ...['__', ' ', '.', ''].map(sep => rec[parts.join(sep)])];
  const hit = candidates.find(v => v !== undefined && v !== null && v !== '');
  return hit === undefined ? null : hit;
};

// Zapier stringifies as it flattens, so a boolean can arrive as "true" and a
// currency as "39500". Salesforce's own JSON sends them typed.
const sfBool = (v) => (typeof v === 'boolean' ? v : /^true$/i.test(String(v ?? '')));
const sfNum = (v) => (Number(String(v ?? '').replace(/[$,]/g, '')) || 0);

/**
 * Financial records in Salesforce's own shape, mapped here rather than in the Zap.
 *
 * The mapping used to live in a Zapier Code step, which received each field as a
 * separate comma-joined string and zipped them back into records. Account names
 * contain commas, so one name added an element and shifted every field after it by
 * one — records ended up carrying the previous record's account, and 68 of 98 were
 * flagged as mis-linked when nothing in Salesforce was wrong at all. There is no
 * safe delimiter when the data is free text, so the reconstruction moves here where
 * records stay whole objects and the mapping is in version control.
 */
export async function applyFinancialsRaw(pool, records) {
  refuseIfEmpty(records, 'financial records');
  return applyFinancials(pool, records.map(r => ({
    financial_id: sfField(r, 'Id'),
    name: sfField(r, 'Name'),
    purpose: sfField(r, 'Purpose_for_Creating_Financial__c'),
    amount: sfNum(sfField(r, 'Security_Total_Potential_Value__c')),
    upfront: sfNum(sfField(r, 'Security_Upfrton__c')),
    implementation: sfNum(sfField(r, 'Security_Potential_Implementatoin_Fees__c')),
    created_date: sfField(r, 'CreatedDate'),
    account_id: sfField(r, 'Account__c'),
    organization: sfField(r, 'Account__r.Name'),
    domain: sfField(r, 'Account__r.Website'),
    contract_id: sfField(r, 'Contract__c'),
    contract_number: sfField(r, 'Contract__r.ContractNumber'),
    opportunity_id: sfField(r, 'Opportunity__c'),
    opportunity_name: sfField(r, 'Opportunity__r.Name'),
    opportunity_stage: sfField(r, 'Opportunity__r.StageName'),
    opportunity_is_won: sfBool(sfField(r, 'Opportunity__r.IsWon')),
    opportunity_account_id: sfField(r, 'Opportunity__r.AccountId'),
    non_security: sfBool(sfField(r, 'Opportunity__r.Check_if_NOT_Security_Opportunity__c')),
  })));
}

export const APPLIERS = {
  salesforce_wins: applyWins,
  // Salesforce's own field names, mapped server-side. Preferred over the mapped
  // form: the mapping is testable here and cannot be silently misaligned in transit.
  salesforce_financials_raw: applyFinancialsRaw,
  salesforce_applications: applyApplications,
};

/**
 * Push sources that were replaced, and by what.
 *
 * `salesforce_financials` took financials already mapped into this app's column
 * names, which meant the mapping lived in a Zapier Code step. #137 moved it here
 * as `salesforce_financials_raw` and repointed the Zap the same day; the mapped
 * key has not been posted since, and is dropped from APPLIERS above so the shape
 * that caused the comma-shift misattribution cannot be delivered again.
 *
 * Retiring a push source leaves its last run behind. The freshness strip reads
 * one row per source, newest first, so a source nothing will ever write again
 * keeps whatever it finished on — here a refusal, sitting red on the dashboard
 * permanently while the feed it names is healthy under its new one.
 *
 * Keyed by source rather than removed from sync_runs so the history stays
 * readable, and so the row comes back on its own if the source is ever revived.
 */
const SUPERSEDED_PUSH_SOURCES = {
  salesforce_financials: 'salesforce_financials_raw',
};

// ─────────────────────────────────────────────────────────────
// Pull sources — used only when this app has its own API access.
// ─────────────────────────────────────────────────────────────
async function syncWins(pool) {
  const stage = process.env.SF_WON_STAGE || DEFAULT_STAGE;
  const records = await soql(
    // Check_if_NOT_Security_Opportunity__c excludes work that is not part of the
    // security grant business. Twelve won opportunities carried it when this filter
    // was added — real revenue, but a different line of business, and counting it
    // here made the dashboard disagree with the "All Sec. Financials Only" report
    // leadership works from. Matching that report is the point of the filter.
    // Written as != true rather than = false so a record with the box never touched
    // (null) still counts as security work.
    `SELECT Id, Account.Name, Account.Website, EST_TCV__c, CloseDate
       FROM Opportunity
      WHERE StageName = '${stage.replace(/'/g, "\\'")}'
        AND CloseDate >= ${winsSince()}
        AND Check_if_NOT_Security_Opportunity__c != true`
  );
  return applyWins(pool, records.map(r => ({
    opportunity_id: r.Id,
    organization: r.Account?.Name || null,
    domain: r.Account?.Website || null,
    amount: r.EST_TCV__c ?? 0,
    close_date: r.CloseDate || null,
  })));
}

// Financial records — the authoritative source for revenue. See the comment above
// COUNTABLE_FINANCIAL in marketing.js for why this replaced the opportunity total.
//
// The query deliberately filters on NOTHING but the date floor. Purpose, the
// non-security flag and the presence of an opportunity are all pulled as data and
// applied downstream, so the dashboard can report what each one excluded. Filtering
// here would make an excluded record indistinguishable from one that never existed,
// which is the failure this whole change is about.
//
// Field API names are unverified against the org: production runs the delivered
// path (a Zap POSTs to /sync/push), not this pull, so nothing here has executed.
// SF_FINANCIAL_* env vars override each name — set them and confirm in Object
// Manager before enabling the pull for this source.
const F = {
  object: process.env.SF_FINANCIAL_OBJECT || 'Financials__c',
  amount: process.env.SF_FINANCIAL_AMOUNT_FIELD || 'Security_Total_Potential_Value__c',
  upfront: process.env.SF_FINANCIAL_UPFRONT_FIELD || 'Security_Upfrton__c',
  implementation: process.env.SF_FINANCIAL_IMPL_FIELD || 'Security_Potential_Implementatoin_Fees__c',
  purpose: process.env.SF_FINANCIAL_PURPOSE_FIELD || 'Purpose_for_Creating_Financial__c',
  opportunity: process.env.SF_FINANCIAL_OPPORTUNITY_FIELD || 'Opportunity__c',
  account: process.env.SF_FINANCIAL_ACCOUNT_FIELD || 'Account__c',
  contract: process.env.SF_FINANCIAL_CONTRACT_FIELD || 'Contract__c',
};

async function syncFinancials(pool) {
  const rel = F.opportunity.replace(/__c$/, '__r');
  const acc = F.account.replace(/__c$/, '__r');
  const con = F.contract.replace(/__c$/, '__r');
  const records = await soql(
    // The account comes from the financial's OWN lookup, not the opportunity's.
    // Those two differing is a data problem the dashboard exists to catch, so
    // reading both from one place would make the check impossible to fail.
    `SELECT Id, Name, CreatedDate, ${F.purpose}, ${F.amount}, ${F.upfront}, ${F.implementation},
            ${F.account}, ${acc}.Name, ${acc}.Website,
            ${F.contract}, ${con}.ContractNumber,
            ${F.opportunity},
            ${rel}.Name, ${rel}.StageName, ${rel}.IsWon, ${rel}.AccountId,
            ${rel}.Check_if_NOT_Security_Opportunity__c
       FROM ${F.object}
      WHERE CreatedDate >= ${financialsSince()}T00:00:00Z`
  );
  return applyFinancials(pool, records.map(r => {
    const o = r[rel] || {};
    const a = r[acc] || {};
    const c = r[con] || {};
    return {
      financial_id: r.Id,
      name: r.Name || null,
      purpose: r[F.purpose] || null,
      amount: r[F.amount] ?? 0,
      upfront: r[F.upfront] ?? 0,
      implementation: r[F.implementation] ?? 0,
      created_date: r.CreatedDate || null,
      opportunity_id: r[F.opportunity] || null,
      opportunity_name: o.Name || null,
      opportunity_stage: o.StageName || null,
      opportunity_is_won: typeof o.IsWon === 'boolean' ? o.IsWon : null,
      opportunity_account_id: o.AccountId || null,
      non_security: o.Check_if_NOT_Security_Opportunity__c === true,
      account_id: r[F.account] || null,
      organization: a.Name || null,
      domain: a.Website || null,
      contract_id: r[F.contract] || null,
      contract_number: c.ContractNumber || null,
    };
  }));
}

async function syncApplications(pool) {
  // Application_Status__c, spelled the ordinary way. This used to read
  // Applicaiton_Status__c, with a comment asserting the field was misspelled in
  // Salesforce and that the typo was the real API name. It is not. The org
  // rejects it outright:
  //
  //   No such column 'Applicaiton_Status__c' on entity 'Applications__c'
  //
  // Nothing caught it because nothing ran it: this pull path needs SF_CLIENT_ID
  // / SF_USERNAME / SF_PRIVATE_KEY, the org is Professional Edition, and the
  // connector has been idle since it was written (sync/status reports
  // configured: false). The claim was copied into a Zap and a real-time
  // workflow on the strength of the comment alone, and only surfaced when the
  // Zap actually issued the query. Two other misspellings on this object ARE
  // real -- Security_Upfrton__c and Security_Potential_Implementatoin_Fees__c,
  // both confirmed in the Object Manager -- which is presumably how this one
  // got believed.
  const records = await soql(
    `SELECT Id, Name, Account__c, Account__r.Name, Grant_Program__c, State__c,
            Application_Status__c, Total_Amount_Requested__c,
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
    status: r.Application_Status__c || null,
    amount_requested: r.Total_Amount_Requested__c ?? 0,
    amount_awarded: r.Actual_Amount_Awarded__c ?? 0,
    max_award: r.Maximum_Award_Amount__c ?? 0,
  })));
}

const SOURCES = {
  salesforce_wins: syncWins,
  salesforce_financials: syncFinancials,
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
      // A superseded source is hidden only while the pull transport is off. The
      // pull path writes its runs under the SAME name as the retired push source
      // (SOURCES.salesforce_financials), so filtering by name unconditionally
      // would hide a feed that had genuinely come back to life. Configuring
      // Salesforce credentials brings the row back with it.
      const hidden = salesforceConfigured() ? [] : Object.keys(SUPERSEDED_PUSH_SOURCES);
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (source) source, started_at, finished_at, ok, rows_seen, rows_removed, note, error
          FROM sync_runs
         WHERE NOT (source = ANY($1))
         ORDER BY source, started_at DESC`, [hidden]);
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
    if (!zapSecretOk(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    // The source can ride in the query string, and the records can arrive still
    // wrapped in whatever the transport put around them.
    //
    // This exists so a sender never has to MAP the payload field by field. Zapier
    // can only carry a record set between steps as parallel comma-joined strings —
    // one account name containing a comma shifts every record after it, which is
    // how 68 financials were reported as mis-linked when none were. Its raw
    // pass-through avoids the mapping layer completely, but then the body is
    // whatever the previous step produced and nothing can be added to it. So the
    // source comes from the URL instead, and the records are looked for in the
    // shapes that pass-through actually produces: Salesforce's own query response,
    // or that response inside Zapier's raw-request envelope.
    const source = req.body?.source || req.query?.source;
    const records = [
      req.body?.records,
      req.body?.results?.[0]?.body?.records,
      req.body?.body?.records,
    ].find(Array.isArray) ?? req.body?.records;

    // What the sender actually sent. A rejection that only restates the rule leaves
    // the caller guessing at the difference between "I sent the wrong value" and "my
    // body never arrived as JSON at all" — and those have completely different fixes.
    // Zapier's plain POST action flattens its Data fields, so an array of records
    // arrives mangled or not at all; its Custom Request action sends a raw body and
    // works. Ten rounds went into discovering that from an error that could have said
    // it, so this reports the content type and the keys that survived.
    const diagnose = (error) => res.status(400).json({
      error,
      received_source: source ?? null,
      source_in_query_string: req.query?.source ?? null,
      received_keys: Object.keys(req.body || {}),
      received_content_type: req.headers['content-type'] || null,
      records_type: Array.isArray(records) ? `array(${records.length})` : typeof records,
      expected: '{"source":"salesforce_financials_raw","records":[{...}]}',
      hint: Object.keys(req.body || {}).length === 0
        ? 'nothing was parsed from the body — send a raw JSON string with Content-Type: application/json (in Zapier, Webhooks → Custom Request, not POST)'
        : 'the body parsed, but the fields above are not the ones expected',
    });

    if (!APPLIERS[source]) {
      return diagnose(`source must be one of: ${Object.keys(APPLIERS).join(', ')}`);
    }
    if (!Array.isArray(records)) {
      return diagnose('records must be an array (the complete current set for this source)');
    }
    _schemaReady = _schemaReady || ensureSyncSchema(pool);
    await _schemaReady;

    // A delivery is the COMPLETE current set by contract -- anything absent is
    // treated as deleted. So a sender that hands over part of the set silently
    // deletes the rest, and a short delivery is indistinguishable from a genuine
    // shrink. The existing rails do not catch it: a partial pull is neither empty
    // nor necessarily half the table. Two financials went missing this way and
    // stayed missing for nineteen days, because 124 of 126 looks like a fine day.
    //
    // Salesforce states both facts in its own query response, so the fix is just
    // to read them:
    //
    //   totalSize   how many records MATCHED -- not how many were handed over
    //   done:false  "this is one page; ask nextRecordsUrl for the remainder"
    //
    // A sender that follows pagination reports done:true and a complete set, so
    // this never fires for it. One that stops at the first page trips it on its
    // first run rather than pruning the remainder away every night. Both fields
    // are optional: a sender that says nothing is trusted exactly as before.
    const stated = [req.body, req.body?.results?.[0]?.body, req.body?.body]
      .find((o) => o && (o.totalSize != null || o.total_size != null
                      || o.expected != null || o.done != null)) || {};
    const expected = Number(stated.totalSize ?? stated.total_size ?? stated.expected);
    const morePages = stated.done === false;

    // Recorded as a sync_runs row exactly like a pull, so the freshness strip and
    // the failure history work identically no matter which transport delivered it.
    // The check runs INSIDE the runner for the same reason: a refusal has to be as
    // visible as a failed pull, and refusing before the applier means nothing is
    // upserted and, crucially, nothing is pruned.
    const result = await runSource(pool, source, () => {
      if (morePages) {
        throw new Error(`sender delivered one page of ${records.length} and did not follow `
          + 'pagination (done: false) — refusing a partial sync');
      }
      if (Number.isFinite(expected) && records.length < expected) {
        throw new Error(`received ${records.length} of ${expected} records — refusing a partial sync`);
      }
      return APPLIERS[source](pool, records);
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Says what arrived, and answers 200 so a sender can actually read the reply.
  //
  // A 400 carries the same diagnosis, but Zapier's test harness surfaces the body
  // of a success and swallows the body of an error — so the one message that
  // explains the failure is the one nobody can see. Two separate debugging loops
  // have now been spent on that. Point the webhook here, read the response, point
  // it back.
  //
  // Writes nothing, reads nothing, and truncates to one record: this is for
  // checking shape, not for moving data.
  app.post('/api/marketing/sync/echo', express.json({ limit: '10mb' }), (req, res) => {
    if (!zapSecretOk(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const body = req.body || {};
    const records = Array.isArray(body.records) ? body.records : null;
    const first = records?.[0];
    res.json({
      ok: true,
      note: 'diagnostic only — nothing was stored',
      content_type: req.headers['content-type'] || null,
      body_keys: Object.keys(body),
      // Read the same way /sync/push reads it, or this reports a null source for a
      // request that would actually have been accepted — which is worse than silence.
      source: body.source ?? req.query?.source ?? null,
      source_valid: Boolean(APPLIERS[body.source ?? req.query?.source]),
      source_from: body.source ? 'body' : (req.query?.source ? 'query string' : null),
      records_type: records ? `array(${records.length})` : typeof body.records,
      // Which field names actually survived the trip. The whole reason the last
      // attempt failed was a disagreement about this, invisible from both ends.
      first_record_keys: first && typeof first === 'object' ? Object.keys(first) : null,
      first_record: first ?? null,
      accepted_sources: Object.keys(APPLIERS),
    });
  });

  // Manual kick — same shared secret as the ingest endpoints.
  app.post('/api/marketing/sync/salesforce', async (req, res) => {
    if (!zapSecretOk(req)) {
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
