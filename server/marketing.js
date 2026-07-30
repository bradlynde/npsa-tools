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

  // Two ways a booking stops representing real pipeline:
  //   unqualified — a human decided it was never a prospect (a consultant or
  //                 competitor booking a slot, a mis-targeted lead)
  //   cancelled   — Calendly says the meeting was called off
  // Both are excluded from every count but stay on the list: removed from the
  // maths, not from the record. unqualified is driven by manual_override, so a
  // re-sync from Calendly or Instantly can never undo a human's judgement.
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unqualified  BOOLEAN DEFAULT FALSE;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled    BOOLEAN DEFAULT FALSE;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  `).catch(err => console.error('bookings disposition-columns error:', err.message));

  // Source of truth for EVERY Salesforce win — matched to a booking or not.
  // booking_id is NULL for untracked / pre-funnel wins (closed before the booking
  // funnel existed, or a deal that never came through a tracked booking). Totals
  // and the untracked bucket come from here; the funnel/attribution view keeps
  // reading the bookings table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sf_wins (
      opportunity_id  TEXT PRIMARY KEY,
      organization    TEXT,
      domain          TEXT,
      amount          NUMERIC DEFAULT 0,
      close_date      TIMESTAMPTZ,
      booking_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('sf_wins schema error:', err.message));

  // Seed sf_wins from wins already attributed onto bookings, so the Salesforce
  // band is coherent immediately (before the backfill is re-run to pull in the
  // untracked ones). Idempotent: existing rows are left alone.
  await pool.query(`
    INSERT INTO sf_wins (opportunity_id, organization, amount, booking_id, close_date)
    SELECT kv.key, b.organization, (kv.value)::numeric, b.id, b.won_at
      FROM bookings b, jsonb_each_text(b.won_opportunities) kv
     WHERE b.won_opportunities IS NOT NULL AND b.won_opportunities <> '{}'
    ON CONFLICT (opportunity_id) DO NOTHING;
  `).catch(err => console.error('sf_wins seed error:', err.message));

  // Salesforce grant Applications (Applications__c). An organization usually has
  // several — one per grant program/year — so these are tracked separately from
  // wins (which are the sales-side count of organizations/contracts). status_bucket
  // is derived on ingest so the dashboard never has to parse SF status strings.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sf_applications (
      application_id    TEXT PRIMARY KEY,
      name              TEXT,
      organization      TEXT,
      account_id        TEXT,
      opportunity_id    TEXT,
      grant_program     TEXT,
      state             TEXT,
      status            TEXT,
      status_bucket     TEXT,
      amount_requested  NUMERIC DEFAULT 0,
      amount_awarded    NUMERIC DEFAULT 0,
      max_award         NUMERIC DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('sf_applications schema error:', err.message));
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
// Asks Calendly two separate questions about one event:
//   cancelled — was the meeting called off? Answerable at any time, and the answer
//               that matters most is about a meeting still in the future.
//   held      — did the invitee actually turn up? Only meaningful once it has passed.
//
// These used to be conflated: a cancellation was recorded as "not held", and the
// check only ran for meetings already in the past. So a meeting cancelled today for
// next month stayed on the dashboard as an upcoming appointment until its date came
// round — which is exactly the case this is being asked to fix.
//
// checkAttendance skips the second API call for events that have not happened yet.
// Returns null for anything it cannot determine, so a missing token or a Calendly
// outage leaves existing values untouched rather than overwriting them.
async function calendlyStatus(eventUri, checkAttendance) {
  const key = process.env.CALENDLY_API_TOKEN;
  if (!key || !eventUri) return { cancelled: null, held: null, source: null };
  try {
    const ev = await fetch(eventUri, { headers: { Authorization: `Bearer ${key}` } });
    if (!ev.ok) return { cancelled: null, held: null, source: null };
    const status = (await ev.json())?.resource?.status;
    // A cancellation says nothing about attendance, so it deliberately leaves held
    // alone. Writing held=false here was the original conflation, and it stuck: an
    // event cancelled and then reinstated kept "not held" forever, because a future
    // meeting has no attendance to re-read. Cancelled rows are excluded from the
    // counts anyway, so there is nothing to gain by answering a question nobody asked.
    if (status === 'canceled') return { cancelled: true, held: null, source: null };
    if (status !== 'active') return { cancelled: null, held: null, source: null };
    // Still on the calendar. Attendance is the only open question, and only in the past.
    if (!checkAttendance) return { cancelled: false, held: null, source: null };
    const inv = await fetch(`${eventUri}/invitees`, { headers: { Authorization: `Bearer ${key}` } });
    if (inv.ok) {
      const first = ((await inv.json()).collection || [])[0];
      if (first?.no_show) return { cancelled: false, held: false, source: 'calendly' };
      if (first) return { cancelled: false, held: true, source: 'calendly' };
    }
    return { cancelled: false, held: null, source: null };
  } catch {
    return { cancelled: null, held: null, source: null };
  }
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

  // --- Cancelled + held (one Calendly lookup answers both) ---
  // Attendance is only worth asking about once the meeting has passed; cancellation
  // is asked every time, because a future meeting being called off is the whole point.
  const past = row.meeting_date && new Date(row.meeting_date) < new Date();
  const st = await calendlyStatus(row.event_uri, Boolean(past));

  let cancelled = row.cancelled === true;
  let cancelledAt = row.cancelled_at;
  if (st.cancelled === true && !cancelled) { cancelled = true; cancelledAt = new Date(); }
  else if (st.cancelled === false) { cancelled = false; cancelledAt = null; } // rebooked/reinstated
  // st.cancelled === null means Calendly could not answer — leave what we have.

  let held = row.held, heldSource = row.held_source;
  if (typeof override.held === 'boolean') { held = override.held; heldSource = 'manual'; }
  else if (st.held !== null) { held = st.held; heldSource = st.source; }

  // --- Unqualified (human judgement only, never inferred) ---
  const unqualified = override.unqualified === true;

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
       unqualified=$9, cancelled=$10, cancelled_at=$11,
       enriched_at=NOW(), updated_at=NOW()
     WHERE id=$12`,
    [campaign, channel, source, held, heldSource, becameClient, letterId, fee,
     unqualified, cancelled, cancelledAt, id]
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
  // Persist the win itself — EVERY win lands in sf_wins whether or not it maps to a
  // booking (booking_id stays NULL when untracked). Idempotent per opportunity;
  // re-firing refreshes the fields. Once linked to a booking it stays linked unless
  // a later firing matches a different one.
  await pool.query(
    `INSERT INTO sf_wins (opportunity_id, organization, domain, amount, close_date, booking_id)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
     ON CONFLICT (opportunity_id) DO UPDATE
       SET organization = EXCLUDED.organization, domain = EXCLUDED.domain,
           amount = EXCLUDED.amount, close_date = EXCLUDED.close_date,
           booking_id = COALESCE(EXCLUDED.booking_id, sf_wins.booking_id),
           updated_at = NOW()`,
    [opp, org || null, domain || null, amount, wonAt, target ? target.id : null]
  );

  if (!target) return { matched: false };

  // Mirror onto the booking for the funnel / attribution view (multi-grant accumulation).
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

// Rebuild every booking's won_* fields from the surviving sf_wins rows, so the
// funnel view always equals the win store. A booking whose last opportunity was
// deleted gets reset rather than left showing a win that no longer exists.
// Called after anything that removes wins (reconcile, or a scheduled sync).
async function rebuildBookingWins(pool) {
  await pool.query(`
    UPDATE bookings b SET
      won_opportunities = COALESCE(w.map, '{}'::jsonb),
      won_amount        = COALESCE(w.total, 0),
      won               = (w.total IS NOT NULL),
      won_source        = CASE WHEN w.total IS NOT NULL THEN 'salesforce' ELSE NULL END,
      updated_at        = NOW()
    FROM (
      SELECT bk.id,
             (SELECT jsonb_object_agg(s.opportunity_id, s.amount) FROM sf_wins s WHERE s.booking_id = bk.id) AS map,
             (SELECT SUM(s.amount) FROM sf_wins s WHERE s.booking_id = bk.id) AS total
      FROM bookings bk
      WHERE bk.won = TRUE OR EXISTS (SELECT 1 FROM sf_wins s WHERE s.booking_id = bk.id)
    ) w
    WHERE b.id = w.id`);
}

// ─────────────────────────────────────────────────────────────
// 7c. Applications (Salesforce Applications__c — grant applications)
// An org typically has several (one per grant program/year), so these are counted
// separately from wins. Salesforce status strings are free-form and get renamed, so
// they're bucketed once here and the dashboard only ever reads the bucket:
//   awarded   — decided and accepted; amount_awarded is real money brought in
//   denied    — decided and rejected
//   pending   — submitted, awaiting the award notification (money still in play)
//   preparing — being written; not yet submitted
// ─────────────────────────────────────────────────────────────
function applicationBucket(status) {
  const s = (status || '').toLowerCase();
  if (!s) return 'preparing';
  if (s.includes('accept') || s.includes('award')) return 'awarded';
  if (s.includes('den') || s.includes('reject')) return 'denied';
  if (s.includes('submit')) return 'pending';
  if (s.includes('prepar') || s.includes('draft')) return 'preparing';
  return 'preparing';
}

// A Salesforce lookup field (e.g. Account__c) resolves to a record ID, not a name,
// so a Zap mapped to the lookup instead of Account.Name sends "001TV00000jRoiYAE".
// Storing that would replace real org names with opaque IDs. SF IDs are exactly 15
// or 18 alphanumerics with no spaces — real org names effectively never look like
// that — so treat them as "no name given" and keep whatever we already have.
// Salesforce IDs are 15-18 unbroken alphanumerics mixing letters and digits
// ("001TV00000jRoiYAE"). Real organization names in this data either contain a
// space, are shorter, or carry no digits — so require all three traits before
// rejecting. A false positive is harmless anyway: the upsert COALESCEs, so the
// worst case is "leave the existing name alone" rather than losing data.
const looksLikeSfId = (v) => /^[A-Za-z0-9]{15,18}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
const cleanOrgName = (s) => {
  const v = (s == null ? '' : String(s)).trim();
  if (!v || looksLikeSfId(v)) return null;
  return v;
};

async function recordApplication(pool, a) {
  const id = (a.application_id || '').toString().trim();
  if (!id) return { ok: false, reason: 'missing application_id' };
  const status = (a.status || '').trim();
  const bucket = applicationBucket(status);
  // Only an awarded application counts as money brought in; anything else is 0 even
  // if Salesforce carries a stale figure.
  const awarded = bucket === 'awarded' ? Number(a.amount_awarded) || 0 : 0;
  // If the org name came through as a record ID, it's the Account ID — keep it in
  // the field that actually means that rather than throwing it away.
  const orgRaw = (a.organization == null ? '' : String(a.organization)).trim();
  const accountId = a.account_id || (orgRaw && looksLikeSfId(orgRaw) ? orgRaw : null);
  await pool.query(
    `INSERT INTO sf_applications (application_id, name, organization, account_id, opportunity_id,
        grant_program, state, status, status_bucket, amount_requested, amount_awarded, max_award)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (application_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, sf_applications.name),
           -- never let a missing/ID-shaped org name wipe a good one
           organization = COALESCE(EXCLUDED.organization, sf_applications.organization),
           account_id = COALESCE(EXCLUDED.account_id, sf_applications.account_id),
           opportunity_id = COALESCE(EXCLUDED.opportunity_id, sf_applications.opportunity_id),
           grant_program = COALESCE(EXCLUDED.grant_program, sf_applications.grant_program),
           state = COALESCE(EXCLUDED.state, sf_applications.state),
           -- status is what the Zap exists to update, so it always applies
           status = EXCLUDED.status, status_bucket = EXCLUDED.status_bucket,
           -- amounts: take a real figure; a zero/absent one must not erase a known
           -- value (partial payload), but a non-awarded app is always forced to 0
           amount_requested = CASE WHEN EXCLUDED.amount_requested > 0 THEN EXCLUDED.amount_requested
                                   ELSE sf_applications.amount_requested END,
           amount_awarded = CASE WHEN EXCLUDED.amount_awarded > 0 THEN EXCLUDED.amount_awarded
                                 WHEN EXCLUDED.status_bucket <> 'awarded' THEN 0
                                 ELSE sf_applications.amount_awarded END,
           max_award = CASE WHEN EXCLUDED.max_award > 0 THEN EXCLUDED.max_award
                            ELSE sf_applications.max_award END,
           updated_at = NOW()`,
    [id, a.name || null, cleanOrgName(a.organization), accountId, a.opportunity_id || null,
     a.grant_program || null, a.state || null, status || null, bucket,
     Number(a.amount_requested) || 0, awarded, Number(a.max_award) || 0]
  );
  return { ok: true, application_id: id, status_bucket: bucket };
}

// Shared with the scheduled Salesforce connector, so a pulled record travels the
// exact same matching, bucketing and guard logic as a pushed one — one code path,
// one set of rules, regardless of how the record arrived.
export { recordWin, recordApplication, rebuildBookingWins };

// ─────────────────────────────────────────────────────────────
// 8. Routes
// ─────────────────────────────────────────────────────────────
// Every dashboard count uses this one predicate, so "how many bookings" has exactly
// one answer no matter which tile is asking. An unqualified or cancelled booking is
// still a row in the table and still appears in the list — it is removed from the
// arithmetic, not from the record.
const COUNTABLE = `NOT COALESCE(unqualified, FALSE) AND NOT COALESCE(cancelled, FALSE)`;

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

  // Reconcile sf_wins against the authoritative Salesforce set. Body:
  // { opportunity_ids: [...] } — the complete current list of won opportunities.
  // Any sf_wins row NOT in that list is deleted (a win that was reopened, deleted,
  // re-staged, or was a test ingest), and each affected booking's funnel win-fields
  // are rebuilt from the surviving sf_wins rows. This keeps the dashboard from
  // drifting ABOVE Salesforce over time. Guarded by the same shared secret.
  app.post('/api/marketing/wins/reconcile', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const ids = Array.isArray(req.body?.opportunity_ids) ? req.body.opportunity_ids.map(String) : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ error: 'opportunity_ids (non-empty array) required' });
    }
    // The id list is a point-in-time snapshot, so it cannot speak for wins that
    // closed after it was exported. Without a bound, reconcile would delete a
    // legitimately new win the live Zap had already delivered — indistinguishable
    // from a stale row. covers_through marks how far the snapshot is authoritative;
    // anything closing later is left alone.
    const coversThrough = req.body?.covers_through || null;
    try {
      const { rows: stale } = await pool.query(
        `DELETE FROM sf_wins
           WHERE NOT (opportunity_id = ANY($1))
             AND ($2::timestamptz IS NULL OR close_date IS NULL OR close_date <= $2::timestamptz)
           RETURNING opportunity_id, booking_id`, [ids, coversThrough]);

      await rebuildBookingWins(pool);

      res.json({ ok: true, removed: stale.length, removed_ids: stale.map(r => r.opportunity_id),
        kept: ids.length, covers_through: coversThrough });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Applications ingest (called by the Salesforce Application Zap on create+update).
  app.post('/api/marketing/applications/ingest', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await recordApplication(pool, req.body || {});
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Same drift protection as wins: delete any application not in the authoritative set.
  app.post('/api/marketing/applications/reconcile', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const ids = Array.isArray(req.body?.application_ids) ? req.body.application_ids.map(String) : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ error: 'application_ids (non-empty array) required' });
    }
    // Same snapshot problem as wins, but applications carry no close date — so the
    // bound is insert time instead: a row this dashboard first saw after the
    // snapshot was taken came from the live Zap and must not be treated as stale.
    const protectAfter = req.body?.protect_created_after || null;
    try {
      const { rows } = await pool.query(
        `DELETE FROM sf_applications
           WHERE NOT (application_id = ANY($1))
             AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)
           RETURNING application_id`, [ids, protectAfter]);
      res.json({ ok: true, removed: rows.length, removed_ids: rows.map(r => r.application_id),
        kept: ids.length, protect_created_after: protectAfter });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Applications summary — counts per bucket, money awarded, and money still pending.
  app.get('/api/marketing/applications/stats', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status_bucket='awarded')::int   AS awarded_count,
          COUNT(*) FILTER (WHERE status_bucket='pending')::int   AS pending_count,
          COUNT(*) FILTER (WHERE status_bucket='preparing')::int AS preparing_count,
          COUNT(*) FILTER (WHERE status_bucket='denied')::int    AS denied_count,
          COALESCE(SUM(amount_awarded)   FILTER (WHERE status_bucket='awarded'),0)::numeric AS awarded_amount,
          COALESCE(SUM(amount_requested) FILTER (WHERE status_bucket='awarded'),0)::numeric AS awarded_requested,
          COALESCE(SUM(amount_requested) FILTER (WHERE status_bucket='pending'),0)::numeric AS pending_amount
        FROM sf_applications`);
      const s = rows[0];
      const decided = s.awarded_count + s.denied_count;
      const { rows: prog } = await pool.query(`
        SELECT COALESCE(grant_program,'—') AS grant_program,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status_bucket='awarded')::int AS awarded_count,
               COUNT(*) FILTER (WHERE status_bucket='pending')::int AS pending_count,
               COALESCE(SUM(amount_awarded)   FILTER (WHERE status_bucket='awarded'),0)::numeric AS awarded_amount,
               COALESCE(SUM(amount_requested) FILTER (WHERE status_bucket='pending'),0)::numeric AS pending_amount
          FROM sf_applications GROUP BY 1 ORDER BY 2 DESC`);
      res.json({
        total: s.total,
        awarded_count: s.awarded_count,
        pending_count: s.pending_count,
        preparing_count: s.preparing_count,
        denied_count: s.denied_count,
        awarded_amount: Number(s.awarded_amount),
        pending_amount: Number(s.pending_amount),
        // Of decided applications, how many were accepted — the win rate that matters.
        acceptance_rate: decided ? s.awarded_count / decided : 0,
        // Of what was asked for on accepted apps, how much actually came through.
        award_fill_rate: Number(s.awarded_requested) > 0 ? Number(s.awarded_amount) / Number(s.awarded_requested) : 0,
        by_program: prog.map(p => ({
          grant_program: p.grant_program,
          total: p.total,
          awarded_count: p.awarded_count,
          pending_count: p.pending_count,
          awarded_amount: Number(p.awarded_amount),
          pending_amount: Number(p.pending_amount),
        })),
      });
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
        FROM bookings WHERE ${COUNTABLE}`);
      const s = rows[0];

      // What was left out, so the exclusions are visible rather than silent. The
      // weekly figures matter most — that is the number reviewed each week.
      const { rows: exrows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE unqualified)::int AS unqualified_count,
          COUNT(*) FILTER (WHERE cancelled)::int   AS cancelled_count,
          COUNT(*) FILTER (WHERE unqualified
            AND booked_on >= date_trunc('week', NOW() + interval '1 day') - interval '1 day'
            AND booked_on <  date_trunc('week', NOW() + interval '1 day') - interval '1 day' + interval '7 days')::int AS unqualified_this_week,
          COUNT(*) FILTER (WHERE cancelled
            AND booked_on >= date_trunc('week', NOW() + interval '1 day') - interval '1 day'
            AND booked_on <  date_trunc('week', NOW() + interval '1 day') - interval '1 day' + interval '7 days')::int AS cancelled_this_week
        FROM bookings`);
      const ex = exrows[0];

      // Salesforce revenue layer — every win, matched to a booking or not.
      const { rows: wrows } = await pool.query(`
        SELECT
          COUNT(*)::int AS sf_count,
          COALESCE(SUM(amount),0)::numeric AS sf_revenue,
          COUNT(*) FILTER (WHERE booking_id IS NOT NULL)::int AS sf_attr_count,
          COALESCE(SUM(amount) FILTER (WHERE booking_id IS NOT NULL),0)::numeric AS sf_attr_revenue,
          COUNT(*) FILTER (WHERE booking_id IS NULL)::int AS sf_untracked_count,
          COALESCE(SUM(amount) FILTER (WHERE booking_id IS NULL),0)::numeric AS sf_untracked_revenue,
          -- Organizations won (the sales-team number): an org with several grants is
          -- still one win. Falls back to the opportunity row when org name is blank.
          COUNT(DISTINCT COALESCE(NULLIF(regexp_replace(lower(organization), '[^a-z0-9]', '', 'g'),''), opportunity_id))::int AS sf_org_count
        FROM sf_wins`);
      const sw = wrows[0];
      const hasSf = sw.sf_count > 0;
      const sfTotalRev = Number(sw.sf_revenue);

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
        // Salesforce layer. Headline = total SF revenue; falls back to the
        // funnel-attributed number until sf_wins is populated by the backfill/Zap.
        won_revenue_total: hasSf ? sfTotalRev : Number(s.won_revenue),
        won_count_total: sw.sf_count,
        won_org_count: sw.sf_org_count,
        attributed_revenue: Number(sw.sf_attr_revenue),
        attributed_count: sw.sf_attr_count,
        untracked_revenue: Number(sw.sf_untracked_revenue),
        untracked_count: sw.sf_untracked_count,
        attribution_coverage: sfTotalRev > 0 ? Number(sw.sf_attr_revenue) / sfTotalRev : 0,
        // Excluded from every figure above.
        unqualified_count: ex.unqualified_count,
        cancelled_count: ex.cancelled_count,
        unqualified_this_week: ex.unqualified_this_week,
        cancelled_this_week: ex.cancelled_this_week,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Untracked / pre-funnel wins — Salesforce wins with no matched booking. Powers
  // the collapsible list in the Salesforce band.
  app.get('/api/marketing/untracked-wins', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT opportunity_id, organization, domain, amount::numeric AS amount, close_date
          FROM sf_wins
         WHERE booking_id IS NULL
         ORDER BY close_date DESC NULLS LAST, amount DESC`);
      res.json(rows.map(r => ({
        opportunity_id: r.opportunity_id,
        organization: r.organization,
        domain: r.domain,
        amount: Number(r.amount),
        close_date: r.close_date,
      })));
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
        FROM bookings WHERE ${COUNTABLE}`);
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
        FROM bookings WHERE ${COUNTABLE} GROUP BY 1, 2 ORDER BY booked DESC`);
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
        FROM bookings WHERE ${COUNTABLE} GROUP BY 1 ORDER BY booked DESC`);
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
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COUNT(*) FILTER (WHERE won)::int AS won,
               COALESCE(SUM(won_amount) FILTER (WHERE won),0)::numeric AS won_amount
        FROM bookings WHERE booked_on IS NOT NULL AND ${COUNTABLE}
        GROUP BY 1 ORDER BY 1`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Sales over time, from Salesforce wins (by close date).
  //   contracts — won opportunities closing in the period
  //   orgs      — distinct organizations with a win in the period
  //   new_orgs  — organizations whose FIRST-EVER win closed in the period. Summing
  //               `orgs` would double-count an org that wins again later, so the
  //               dashboard's cumulative line runs on new_orgs instead.
  //   amount    — NPSA contract value closing in the period
  app.get('/api/marketing/sales-timeseries', async (req, res) => {
    if (!pool) return guard(res);
    const g = req.query.granularity === 'quarter' ? 'quarter' : 'month';
    const stepInterval = g === 'quarter' ? '3 months' : '1 month';
    try {
      // Periods with no wins are filled with zeros (generate_series) — a month with
      // nothing sold has to show as a gap in the trend, not disappear and make the
      // timeline read as continuous.
      const { rows } = await pool.query(`
        WITH w AS (
          SELECT COALESCE(NULLIF(regexp_replace(lower(organization), '[^a-z0-9]', '', 'g'), ''), opportunity_id) AS org_key,
                 date_trunc('${g}', close_date) AS period,
                 amount
            FROM sf_wins
           WHERE close_date IS NOT NULL
        ),
        firsts AS (SELECT org_key, MIN(period) AS first_period FROM w GROUP BY 1),
        bounds AS (SELECT MIN(period) AS lo, MAX(period) AS hi FROM w),
        periods AS (
          SELECT generate_series(lo, hi, INTERVAL '${stepInterval}') AS period FROM bounds
        )
        SELECT to_char(p.period, 'YYYY-MM-DD') AS period,
               COUNT(w.org_key)::int AS contracts,
               COUNT(DISTINCT w.org_key)::int AS orgs,
               COALESCE(SUM(w.amount), 0)::numeric AS amount,
               (SELECT COUNT(*) FROM firsts f WHERE f.first_period = p.period)::int AS new_orgs
          FROM periods p
          LEFT JOIN w ON w.period = p.period
         GROUP BY p.period
         ORDER BY p.period`);
      res.json(rows.map(r => ({
        period: r.period,
        contracts: r.contracts,
        orgs: r.orgs,
        new_orgs: r.new_orgs,
        amount: Number(r.amount),
      })));
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
        // Deliberately unfiltered: excluded bookings still belong on the list, which
        // is the whole point of marking rather than deleting them.
        `SELECT id, booked_on, meeting_date, name, organization, email, told_us,
                attribution_channel, instantly_campaign, host, held, became_client, fee,
                won, won_amount, unqualified, cancelled, cancelled_at
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

  // Manual override toggles (Held / Won / Unqualified).
  // These live in manual_override, which nothing outside this tool reads or writes:
  // marking a booking here never touches Calendly, Instantly or Salesforce, and a
  // re-sync from any of them cannot undo it.
  app.patch('/api/marketing/bookings/:id', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { held, became_client, unqualified } = req.body || {};
      const cur = await pool.query('SELECT manual_override FROM bookings WHERE id=$1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const ov = { ...(cur.rows[0].manual_override || {}) };
      if (typeof held === 'boolean') ov.held = held;
      if (typeof became_client === 'boolean') ov.became_client = became_client;
      if (typeof unqualified === 'boolean') ov.unqualified = unqualified;
      await pool.query('UPDATE bookings SET manual_override=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(ov), req.params.id]);
      await enrichBooking(pool, req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Scheduled refresh. A cancellation is something that happens to a booking after
  // it was created, so nothing about the booking itself prompts a re-check — without
  // a schedule, a cancelled meeting sits on the dashboard until somebody happens to
  // press the enrich button. Upcoming meetings are what matter here, so those are
  // swept rather than the whole table.
  const sweepMinutes = Number(process.env.BOOKING_SWEEP_MINUTES) || 360;
  const sweepUpcoming = async () => {
    if (_enrichRunning) return;
    _enrichRunning = true;
    try {
      const { rows } = await pool.query(
        `SELECT id FROM bookings
          WHERE event_uri IS NOT NULL
            AND (meeting_date IS NULL OR meeting_date > NOW() - interval '7 days')`);
      for (const r of rows) {
        try { await enrichBooking(pool, r.id); } catch (e) { console.error('sweep enrich error:', e.message); }
      }
      if (rows.length) console.log(`[marketing] booking sweep complete: ${rows.length} rows`);
    } finally { _enrichRunning = false; }
  };
  // Off the boot path, so a Calendly outage can never delay the app starting.
  setTimeout(() => { sweepUpcoming().catch(e => console.error('[marketing] startup sweep failed:', e.message)); }, 60_000);
  setInterval(() => { sweepUpcoming().catch(e => console.error('[marketing] sweep failed:', e.message)); }, sweepMinutes * 60_000);
  console.log(`[marketing] booking sweep active — every ${sweepMinutes} minutes`);
}
