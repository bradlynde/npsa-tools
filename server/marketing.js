// server/marketing.js
// NPSA Marketing Dashboard — backend module.
// Drop this file into /server and register it from server/index.js:
//
//     import { registerMarketing } from './marketing.js';
//     // ...after `pool` is created and after app.use(express.json())...
//     registerMarketing(app, pool);        // place BEFORE the app.get('*') SPA fallback
//
// Everything lives here so the change to index.js is two lines.
// The dashboard works fully from UTM tags alone; the Instantly/Calendly
// lookups are best-effort and fail safe (a bad key or endpoint never breaks
// ingestion or the dashboard — the row just stays unenriched).

// ─────────────────────────────────────────────────────────────
// 1. Campaign slug ⇄ name map (edit when campaigns are added)
// ─────────────────────────────────────────────────────────────
const CAMPAIGN_SLUGS = {
  'broader-church-p1': 'Broader Church Campaign – Phase 1',
  'broader-church-p2': 'Broader Church Campaign – Phase 2',
  'broader-church-p3': 'Broader Church Campaign – Phase 3',
  'il-outreach-uncontacted': 'IL Outreach – Uncontacted',
  'il-outreach-contacted': 'IL Outreach – Contacted',
  'tx-nsgp-church': 'TX NSGP – Church',
  'tx-fy26-deadline': 'TX Campaign – FY2026 Deadline Push',
  'christian-schools': 'Christian Schools Campaign',
  'facility-security': 'Facility and Security Campaign',
  'ca-csnsgp-fy26': 'CA Outreach – CSNSGP FY26',
  'xp-campaign': 'XP Campaign',
  'iowa-schools': 'Iowa Schools',
};
const slugToName = (slug) => CAMPAIGN_SLUGS[(slug || '').trim().toLowerCase()] || (slug || null);

// ─────────────────────────────────────────────────────────────
// 2. Schema (same CREATE IF NOT EXISTS pattern as letters/reps)
// ─────────────────────────────────────────────────────────────
async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id                  SERIAL PRIMARY KEY,
      calendly_uri        TEXT UNIQUE,
      event_uri           TEXT,
      booked_on           TIMESTAMPTZ,
      meeting_date        TIMESTAMPTZ,
      name                TEXT,
      email               TEXT,
      organization        TEXT,
      told_us             TEXT,
      referred_by         TEXT,
      utm_source          TEXT,
      utm_medium          TEXT,
      utm_campaign        TEXT,
      has_gclid           BOOLEAN DEFAULT FALSE,
      host                TEXT,
      instantly_campaign  TEXT,
      attribution_channel TEXT,
      attribution_source  TEXT,
      held                BOOLEAN,
      held_source         TEXT,
      became_client       BOOLEAN DEFAULT FALSE,
      client_letter_id    INTEGER,
      fee                 NUMERIC DEFAULT 0,
      won                 BOOLEAN DEFAULT FALSE,
      won_amount          NUMERIC DEFAULT 0,
      won_at              TIMESTAMPTZ,
      won_source          TEXT,
      won_opportunities   JSONB DEFAULT '{}',
      manual_override     JSONB DEFAULT '{}',
      enriched_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('bookings schema error:', err.message));
  // Wins from Salesforce Closed-Won (added after the table already existed in prod).
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS won               BOOLEAN DEFAULT FALSE;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS won_amount        NUMERIC DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS won_at            TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS won_source        TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS won_opportunities JSONB DEFAULT '{}';
  `).catch(err => console.error('bookings wins-columns error:', err.message));
}

// ─────────────────────────────────────────────────────────────
// 3. Instantly reverse-match helpers (best-effort, fail safe)
//    NOTE for dev: verify these v2 paths/field names against the
//    Instantly API docs; if they differ, only the reverse-match is
//    affected — UTM attribution keeps working regardless.
// ─────────────────────────────────────────────────────────────
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
let _campaignCache = { at: 0, map: {} };
let _enrichRunning = false; // guards the background full-sweep enrichment

// Call the Instantly v2 API (Bearer auth) with 429 back-off — an enrichment
// sweep fires ~140 lookups at once. Returns parsed JSON, or null on any non-OK
// response so reverse-match stays best-effort / fail-safe (never throws).
async function instantlyApi(path, init = {}, attempt = 0) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`${INSTANTLY_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (r.status === 429 && attempt < 5) {
      const wait = (Number(r.headers.get('retry-after')) || Math.pow(2, attempt)) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      return instantlyApi(path, init, attempt + 1);
    }
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// { campaignId -> name } for the whole workspace. Paginated (v2 caps at 100 per
// page) and cached 1h. GET /api/v2/campaigns returns { items: [{ id, name }], next_starting_after }.
async function instantlyCampaignMap() {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return {};
  if (Date.now() - _campaignCache.at < 60 * 60 * 1000) return _campaignCache.map; // 1h cache
  const map = {};
  let startingAfter = null;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const data = await instantlyApi(`/campaigns?${qs.toString()}`);
    if (!data) break;
    for (const c of (data.items || (Array.isArray(data) ? data : []))) {
      if (c && c.id) map[c.id] = c.name;
    }
    startingAfter = data.next_starting_after || null;
  } while (startingAfter);
  if (Object.keys(map).length) _campaignCache = { at: Date.now(), map }; // don't cache an empty/failed pull
  return Object.keys(map).length ? map : _campaignCache.map;
}

// All Instantly lead records for an EXACT email, most-recently-created first.
// POST /api/v2/leads/list { search } is fuzzy (matches name/email substrings) and
// a person can be a lead in several campaigns — one record each — so we keep only
// exact-email matches and normalise the campaign id field. Ordering by
// timestamp_created puts the most recent enrolment first.
async function instantlyLeadsForEmail(email) {
  if (!process.env.INSTANTLY_API_KEY || !email) return [];
  const data = await instantlyApi('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: email, limit: 100 }),
  });
  const items = (data && (data.items || data.leads)) || [];
  const want = email.trim().toLowerCase();
  return items
    .map((l) => ({ ...l, campaign: l.campaign || l.campaign_id || null }))
    .filter((l) => l.campaign && (l.email || '').trim().toLowerCase() === want)
    .sort((a, b) => new Date(b.timestamp_created || 0) - new Date(a.timestamp_created || 0));
}

// Best (most-recent) Instantly lead for an email, or null.
async function instantlyFindLead(email) {
  return (await instantlyLeadsForEmail(email))[0] || null;
}

async function instantlyFindLeadByNameOrg(lastName, org) {
  if (!process.env.INSTANTLY_API_KEY || !lastName) return null;
  const data = await instantlyApi('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: lastName, limit: 20 }),
  });
  const items = (data && (data.items || data.leads)) || [];
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(org);
  if (!target) return null;
  const hit = items.find((l) => {
    const c = norm(l.company_name);
    return c && (c.includes(target) || target.includes(c));
  });
  return hit ? { ...hit, campaign: hit.campaign || hit.campaign_id || null } : null;
}

// Free/consumer email providers — never match an Instantly lead on these domains
// (everyone shares them), only on real org domains.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net',
  'att.net', 'verizon.net', 'sbcglobal.net', 'protonmail.com', 'proton.me',
]);

// Recover an Instantly campaign when the exact email didn't match but the booking
// shares an org DOMAIN with an Instantly lead (a different person at the same org,
// or a slightly different address). Skips free/consumer domains.
async function instantlyFindLeadByDomain(domain) {
  const d = (domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!process.env.INSTANTLY_API_KEY || !d || FREEMAIL.has(d)) return null;
  const data = await instantlyApi('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: d, limit: 100 }),
  });
  const items = (data && (data.items || data.leads)) || [];
  const matches = items
    .map((l) => ({ ...l, campaign: l.campaign || l.campaign_id || null }))
    .filter((l) => {
      if (!l.campaign) return false;
      const emailDom = (l.email || '').split('@')[1]?.toLowerCase().replace(/^www\./, '');
      const compDom = (l.company_domain || '').toLowerCase().replace(/^www\./, '');
      return emailDom === d || compDom === d;
    })
    .sort((a, b) => new Date(b.timestamp_created || 0) - new Date(a.timestamp_created || 0));
  return matches[0] || null;
}

// Exported for scripts/test-instantly-match.js (kept out of the app's behaviour).
export { instantlyCampaignMap, instantlyLeadsForEmail, instantlyFindLead };

// ─────────────────────────────────────────────────────────────
// 4. Calendly held-status (best-effort, fail safe)
// ─────────────────────────────────────────────────────────────
async function calendlyHeld(eventUri) {
  const key = process.env.CALENDLY_API_TOKEN;
  if (!key || !eventUri) return { held: null, source: null };
  try {
    const ev = await fetch(eventUri, { headers: { Authorization: `Bearer ${key}` } });
    if (ev.ok) {
      const evData = await ev.json();
      if (evData.resource?.status === 'canceled') return { held: false, source: 'calendly' };
    }
    const inv = await fetch(`${eventUri}/invitees`, { headers: { Authorization: `Bearer ${key}` } });
    if (inv.ok) {
      const invData = await inv.json();
      const first = (invData.collection || [])[0];
      if (first?.no_show) return { held: false, source: 'calendly' };
      if (first) return { held: true, source: 'calendly' };
    }
  } catch { /* fall through */ }
  return { held: null, source: null };
}

// ─────────────────────────────────────────────────────────────
// 5. Channel derivation
// ─────────────────────────────────────────────────────────────
function deriveChannel(row, instantlyCampaign) {
  if (instantlyCampaign) return 'instantly';
  const t = (row.told_us || '').toLowerCase();
  const med = (row.utm_medium || '').toLowerCase();
  const src = (row.utm_source || '').toLowerCase();

  if (t.includes('email from nonprofit') || t.includes('email from npsa')) return 'instantly';

  // UTM-tagged traffic — the most reliable signal when present.
  if (src === 'instantly') return 'instantly';
  if (row.has_gclid || /(^|[-_ ])(cpc|ppc|paid|paidsearch|ads?)([-_ ]|$)/.test(med)) return 'google_ads';
  if (med === 'organic') return 'search';
  if (med === 'email') return 'email';
  if (med.includes('social') || ['facebook', 'instagram', 'twitter', 'x', 'youtube', 'fb', 'ig'].includes(src)) return 'social';
  if (src === 'linkedin' || med === 'linkedin') return 'linkedin';

  // Self-report ("How did you hear about us?") for untagged traffic.
  if (t.includes('refer')) return 'referral';
  if (t.includes('conference') || t.includes('event') || t.includes('trade show')) return 'conference';
  if (t.includes('linkedin')) return 'linkedin';
  if (src.includes('google') || src.includes('bing')
      || t.includes('google') || t.includes('search') || t.includes('online') || t.includes('web')) return 'search';

  return 'direct'; // no signal — direct / other
}

// channel code -> display label (kept in one place; used by the by-channel and
// by-campaign endpoints so the UI shows friendly names).
const CHANNEL_LABELS = {
  instantly: 'Instantly', google_ads: 'Google Ads', search: 'Organic Search', email: 'Email',
  social: 'Social', referral: 'Referral', conference: 'Conference', linkedin: 'LinkedIn', direct: 'Direct / Other',
};
const channelLabel = (c) => CHANNEL_LABELS[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Direct / Other');

// ─────────────────────────────────────────────────────────────
// 6. Enrichment (Instantly campaign + held + became-client/fee)
// ─────────────────────────────────────────────────────────────
async function enrichBooking(pool, id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
  const row = rows[0];
  if (!row) return;
  const override = row.manual_override || {};

  // --- Instantly campaign ---
  let campaign = null, source = 'none';
  if ((row.utm_source || '').toLowerCase() === 'instantly' && row.utm_campaign) {
    campaign = slugToName(row.utm_campaign); source = 'utm';
  } else {
    const lead = await instantlyFindLead(row.email);
    if (lead?.campaign) {
      const map = await instantlyCampaignMap();
      campaign = map[lead.campaign] || null; source = 'reverse_email';
    }
    if (!campaign) {
      const last = (row.name || '').trim().split(/\s+/).pop();
      const lead2 = await instantlyFindLeadByNameOrg(last, row.organization);
      if (lead2?.campaign) {
        const map = await instantlyCampaignMap();
        campaign = map[lead2.campaign] || null; source = 'reverse_name_org';
      }
    }
    if (!campaign) {
      const lead3 = await instantlyFindLeadByDomain((row.email || '').split('@')[1]);
      if (lead3?.campaign) {
        const map = await instantlyCampaignMap();
        campaign = map[lead3.campaign] || null; source = 'reverse_domain';
      }
    }
  }
  const channel = deriveChannel(row, campaign);

  // --- Held ---
  let held = row.held, heldSource = row.held_source;
  if (typeof override.held === 'boolean') { held = override.held; heldSource = 'manual'; }
  else if (row.meeting_date && new Date(row.meeting_date) < new Date()) {
    const h = await calendlyHeld(row.event_uri);
    if (h.held !== null) { held = h.held; heldSource = h.source; }
  }

  // --- Became client + fee (join to letters, same DB) ---
  let becameClient = false, letterId = null, fee = 0;
  if (row.organization) {
    // Bidirectional normalized name match (mirrors recordWin): an LOE's client_name
    // and the booking org often differ in punctuation/length, so match on normalized
    // alphanumerics in either direction rather than a one-way substring. Exact
    // normalized names always match; substring only when both are >= 6 alphanumerics.
    const m = await pool.query(
      `WITH q AS (SELECT regexp_replace(lower($1), '[^a-z0-9]', '', 'g') AS t)
       SELECT l.id, l.total_fee
         FROM letters l, q
        WHERE l.doc_tab NOT IN ('proposal','addendum')
          AND q.t <> ''
          AND ( regexp_replace(lower(l.client_name), '[^a-z0-9]', '', 'g') = q.t
             OR ( length(q.t) >= 6
                  AND length(regexp_replace(lower(l.client_name), '[^a-z0-9]', '', 'g')) >= 6
                  AND ( position(q.t IN regexp_replace(lower(l.client_name), '[^a-z0-9]', '', 'g')) > 0
                     OR position(regexp_replace(lower(l.client_name), '[^a-z0-9]', '', 'g') IN q.t) > 0 ) ) )
        ORDER BY l.created_at DESC LIMIT 1`,
      [row.organization]
    );
    if (m.rows[0]) { becameClient = true; letterId = m.rows[0].id; fee = Number(m.rows[0].total_fee) || 0; }
  }
  if (typeof override.became_client === 'boolean') becameClient = override.became_client;

  await pool.query(
    `UPDATE bookings SET
       instantly_campaign=$1, attribution_channel=$2, attribution_source=$3,
       held=$4, held_source=$5, became_client=$6, client_letter_id=$7, fee=$8,
       enriched_at=NOW(), updated_at=NOW()
     WHERE id=$9`,
    [campaign, channel, source, held, heldSource, becameClient, letterId, fee, id]
  );
}

// ─────────────────────────────────────────────────────────────
// 7. Upsert (ingest)
// ─────────────────────────────────────────────────────────────
async function upsertBooking(pool, b) {
  let existing = null;
  if (b.calendly_uri) {
    const r = await pool.query('SELECT id FROM bookings WHERE calendly_uri=$1', [b.calendly_uri]);
    existing = r.rows[0];
  }
  if (!existing && b.email && b.meeting_date) {
    const r = await pool.query('SELECT id FROM bookings WHERE email=$1 AND meeting_date=$2', [b.email, b.meeting_date]);
    existing = r.rows[0];
  }
  const cols = ['calendly_uri','event_uri','booked_on','meeting_date','name','email','organization',
    'told_us','referred_by','utm_source','utm_medium','utm_campaign','has_gclid','host'];
  const vals = cols.map(c => b[c] ?? null);
  if (existing) {
    const set = cols.map((c, i) => `${c}=COALESCE($${i + 1}, ${c})`).join(', ');
    await pool.query(`UPDATE bookings SET ${set}, updated_at=NOW() WHERE id=$${cols.length + 1}`, [...vals, existing.id]);
    return existing.id;
  }
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(`INSERT INTO bookings (${cols.join(', ')}) VALUES (${ph}) RETURNING id`, vals);
  return r.rows[0].id;
}

// bare registrable domain: strip protocol, leading www., and any path.
const bareDomain = (s) => (s || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

// ─────────────────────────────────────────────────────────────
// 7b. Wins (Salesforce won opportunities — IsWon = true)
// Matched to a booking by org DOMAIN or ORG NAME — not the individual, since the
// contact changes but the org/domain is stable. An org can win several grants
// (Federal + state, etc.), so each opportunity accumulates into the booking's
// won_opportunities map ({ opportunityId: amount }); won_amount is the sum, and
// re-firing the same opportunity just updates its entry (idempotent, no
// double-count). All of an org's grants land on one booking (the most recent),
// so an org that booked twice is still one win.
// ─────────────────────────────────────────────────────────────
async function recordWin(pool, w) {
  const opp = (w.opportunity_id || '').toString().trim();
  if (!opp) return { matched: false, reason: 'missing opportunity_id' };
  const domain = bareDomain(w.domain);
  const org = (w.organization || '').trim();
  const amount = Number(w.amount) || 0;
  const wonAt = w.close_date || null;

  // 1) booking that already counts this opportunity → update in place (idempotent).
  let r = await pool.query(`SELECT id, won_opportunities FROM bookings WHERE won_opportunities ? $1 LIMIT 1`, [opp]);
  let target = r.rows[0];
  // 2) domain match (precise) — same registrable domain on the booking email.
  if (!target && domain) {
    r = await pool.query(
      `SELECT id, won_opportunities FROM bookings
         WHERE regexp_replace(lower(split_part(email,'@',2)), '^www\\.', '') = $1
         ORDER BY booked_on DESC NULLS LAST, id DESC
         LIMIT 1`,
      [domain]
    );
    target = r.rows[0];
  }
  // 3) org-name match — normalized and BIDIRECTIONAL, so a longer, more decorated
  // Salesforce account name ("Killian Hill Baptist Church - Christian School - GA")
  // still matches a plainer booking org ("Killian Hill Baptist Church"). Exact
  // normalized names always match; a substring match only counts when BOTH names are
  // long enough (>= 6 alphanumerics) to avoid tiny-string false positives.
  if (!target && org) {
    r = await pool.query(
      `WITH q AS (SELECT regexp_replace(lower($1), '[^a-z0-9]', '', 'g') AS t)
       SELECT b.id, b.won_opportunities
         FROM bookings b, q
        WHERE q.t <> ''
          AND ( regexp_replace(lower(b.organization), '[^a-z0-9]', '', 'g') = q.t
             OR ( length(q.t) >= 6
                  AND length(regexp_replace(lower(b.organization), '[^a-z0-9]', '', 'g')) >= 6
                  AND ( position(q.t IN regexp_replace(lower(b.organization), '[^a-z0-9]', '', 'g')) > 0
                     OR position(regexp_replace(lower(b.organization), '[^a-z0-9]', '', 'g') IN q.t) > 0 ) ) )
        ORDER BY b.booked_on DESC NULLS LAST, b.id DESC
        LIMIT 1`,
      [org]
    );
    target = r.rows[0];
  }
  if (!target) return { matched: false };

  const map = { ...(target.won_opportunities || {}) };
  map[opp] = amount;
  const total = Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0);
  await pool.query(
    `UPDATE bookings SET won_opportunities=$1, won=TRUE, won_amount=$2,
        won_at=COALESCE($3::timestamptz, won_at), won_source='salesforce', updated_at=NOW()
     WHERE id=$4`,
    [JSON.stringify(map), total, wonAt, target.id]
  );
  return { matched: true, id: target.id, opportunities: Object.keys(map).length, won_amount: total };
}

// ─────────────────────────────────────────────────────────────
// 8. Routes
// ─────────────────────────────────────────────────────────────
export function registerMarketing(app, pool) {
  if (!pool) { console.warn('[marketing] no DB pool — marketing endpoints disabled'); return; }
  ensureSchema(pool);
  const guard = (res) => res.status(503).json({ error: 'Storage not configured' });

  // Ingest (called by Zapier). Protect with a shared secret.
  app.post('/api/marketing/bookings/ingest', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const id = await upsertBooking(pool, req.body || {});
      enrichBooking(pool, id).catch(e => console.error('enrich error:', e.message)); // async, don't block
      res.json({ ok: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Wins ingest (called by Zapier on a Salesforce Closed-Won opportunity).
  // Body: { organization, domain, amount, close_date, opportunity_id }. Same shared secret.
  app.post('/api/marketing/wins/ingest', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await recordWin(pool, req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Re-run enrichment for stale rows (or ?all=1 for everything).
  app.post('/api/marketing/enrich', async (req, res) => {
    if (!pool) return guard(res);
    const all = req.query.all === '1';
    try {
      if (all) {
        // Full sweep re-hits Instantly/Calendly per row, so it can outlast the
        // platform's request timeout. Respond immediately and process in the
        // background; one sweep at a time.
        if (_enrichRunning) return res.json({ ok: true, running: true, message: 'a full sweep is already in progress' });
        const { rows } = await pool.query('SELECT id FROM bookings');
        _enrichRunning = true;
        res.json({ ok: true, started: rows.length });
        (async () => {
          for (const r of rows) { try { await enrichBooking(pool, r.id); } catch (e) { console.error('enrich error:', e.message); } }
          console.log(`[marketing] enrichment sweep complete: ${rows.length} rows`);
        })().catch(e => console.error('enrich sweep error:', e.message)).finally(() => { _enrichRunning = false; });
        return;
      }
      // Stale-only refresh: a small set, run synchronously so a UI reload sees fresh data.
      const { rows } = await pool.query(
        `SELECT id FROM bookings WHERE enriched_at IS NULL OR (meeting_date < NOW() AND held IS NULL)`
      );
      for (const r of rows) { try { await enrichBooking(pool, r.id); } catch (e) { console.error('enrich error:', e.message); } }
      res.json({ ok: true, enriched: rows.length });
    } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });

  // KPI cards
  app.get('/api/marketing/stats', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*)::int AS total_bookings,
          COUNT(*) FILTER (WHERE date_trunc('month', booked_on) = date_trunc('month', NOW()))::int AS bookings_this_month,
          COUNT(*) FILTER (WHERE date_trunc('month', booked_on) = date_trunc('month', NOW() - interval '1 month'))::int AS bookings_last_month,
          -- Sunday 00:00 → Saturday 23:59 (date_trunc('week') is Monday-based, so shift a day to get a Sunday start)
          COUNT(*) FILTER (WHERE booked_on >= date_trunc('week', NOW() + interval '1 day') - interval '1 day'
                             AND booked_on <  date_trunc('week', NOW() + interval '1 day') - interval '1 day' + interval '7 days')::int AS bookings_this_week,
          COUNT(*) FILTER (WHERE became_client)::int AS clients,
          COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS total_fees_won,
          COUNT(*) FILTER (WHERE attribution_channel='instantly')::int AS instantly_count,
          COUNT(*) FILTER (WHERE held IS NOT NULL)::int AS resolved_meetings,
          COUNT(*) FILTER (WHERE held IS TRUE)::int AS held_count,
          COUNT(*) FILTER (WHERE won)::int AS won_count,
          COALESCE(SUM(won_amount) FILTER (WHERE won),0)::numeric AS won_revenue
        FROM bookings`);
      const s = rows[0];
      res.json({
        total_bookings: s.total_bookings,
        bookings_this_week: s.bookings_this_week,
        bookings_this_month: s.bookings_this_month,
        bookings_last_month: s.bookings_last_month,
        client_rate: s.total_bookings ? s.clients / s.total_bookings : 0,
        held_rate: s.resolved_meetings ? s.held_count / s.resolved_meetings : 0,
        instantly_pct: s.total_bookings ? s.instantly_count / s.total_bookings : 0,
        total_fees_won: Number(s.total_fees_won),
        won_count: s.won_count,
        won_rate: s.total_bookings ? s.won_count / s.total_bookings : 0,
        won_revenue: Number(s.won_revenue),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Funnel
  app.get('/api/marketing/funnel', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees,
               COUNT(*) FILTER (WHERE won)::int AS won,
               COALESCE(SUM(won_amount) FILTER (WHERE won),0)::numeric AS won_amount
        FROM bookings`);
      res.json({ ...rows[0], fees: Number(rows[0].fees), won_amount: Number(rows[0].won_amount) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // By Instantly campaign
  app.get('/api/marketing/by-campaign', async (req, res) => {
    if (!pool) return guard(res);
    try {
      // Instantly bookings group by campaign name; everything else is attributed
      // to its self-reported source instead of piling into one "(untagged)" row.
      const { rows } = await pool.query(`
        SELECT CASE
                 WHEN instantly_campaign IS NOT NULL THEN instantly_campaign
                 WHEN attribution_channel = 'instantly'   THEN 'Instantly – campaign unknown'
                 WHEN attribution_channel = 'google_ads'  THEN 'Google Ads'
                 WHEN attribution_channel = 'search'      THEN 'Organic Search'
                 WHEN attribution_channel = 'email'       THEN 'Email'
                 WHEN attribution_channel = 'social'      THEN 'Social'
                 WHEN attribution_channel = 'linkedin'    THEN 'LinkedIn'
                 WHEN attribution_channel = 'referral'    THEN 'Referral'
                 WHEN attribution_channel = 'conference'  THEN 'Conference'
                 WHEN COALESCE(NULLIF(attribution_channel,''),'direct') = 'direct' THEN 'Direct / Other'
                 ELSE initcap(attribution_channel)
               END AS campaign,
               (instantly_campaign IS NOT NULL) AS is_campaign,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
        FROM bookings GROUP BY 1, 2 ORDER BY booked DESC`);
      res.json(rows.map(r => ({ ...r, fees: Number(r.fees) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // By self-report channel
  app.get('/api/marketing/by-channel', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT COALESCE(NULLIF(attribution_channel,''),'direct') AS channel,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
        FROM bookings GROUP BY 1 ORDER BY booked DESC`);
      res.json(rows.map(r => ({ ...r, channel: channelLabel(r.channel), fees: Number(r.fees) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Time series
  app.get('/api/marketing/timeseries', async (req, res) => {
    if (!pool) return guard(res);
    const g = req.query.granularity === 'month' ? 'month' : 'week';
    try {
      const { rows } = await pool.query(`
        SELECT to_char(date_trunc('${g}', booked_on), 'YYYY-MM-DD') AS period,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE became_client)::int AS clients
        FROM bookings WHERE booked_on IS NOT NULL
        GROUP BY 1 ORDER BY 1`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Raw table (drill-down)
  app.get('/api/marketing/bookings', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const search = req.query.search || '';
      const channel = req.query.channel || '';
      const campaign = req.query.campaign || '';
      const { rows } = await pool.query(
        `SELECT id, booked_on, meeting_date, name, organization, email, told_us,
                attribution_channel, instantly_campaign, host, held, became_client, fee,
                won, won_amount
         FROM bookings
         WHERE ($1='' OR name ILIKE '%'||$1||'%' OR organization ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%')
           AND ($2='' OR attribution_channel=$2)
           AND ($3='' OR instantly_campaign=$3)
         ORDER BY booked_on DESC NULLS LAST LIMIT 500`,
        [search, channel, campaign]
      );
      res.json(rows.map(r => ({ ...r, fee: Number(r.fee), won_amount: Number(r.won_amount) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Manual override toggles (Held / Won)
  app.patch('/api/marketing/bookings/:id', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { held, became_client } = req.body || {};
      const cur = await pool.query('SELECT manual_override FROM bookings WHERE id=$1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const ov = { ...(cur.rows[0].manual_override || {}) };
      if (typeof held === 'boolean') ov.held = held;
      if (typeof became_client === 'boolean') ov.became_client = became_client;
      await pool.query('UPDATE bookings SET manual_override=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(ov), req.params.id]);
      await enrichBooking(pool, req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
