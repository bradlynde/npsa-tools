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
// 1. Campaign slug → Instantly campaign ID
// ─────────────────────────────────────────────────────────────
// Booking links carry a short slug in utm_campaign. This maps that slug to the
// campaign's Instantly ID; the NAME is always resolved from Instantly.
//
// It used to map the slug straight to a hand-typed name, and that put the same
// campaign in the table twice. A booking that arrived with a UTM tag got the
// hand-typed name; one recovered by reverse lookup got Instantly's own name, via
// instantlyCampaignMap(). The two were never going to agree:
//
//   hand-typed                            Instantly
//   Broader Church Campaign – Phase 3     Broader Church Campaign - Phase 3 (May 2026)
//   CA Outreach – CSNSGP FY26             CA Outreach - CSNSGP FY26
//   XP Campaign                           XP Campaign 11.5.2025
//
// Eight of the thirteen entries were typed with an EN DASH (U+2013) where all
// nine hyphenated Instantly names use a plain hyphen, so those could not match
// even in principle — one campaign, two rows, for as long as both paths ran.
// Several were also simply out of date, which no amount of dash-fixing helps.
//
// An ID does not drift. Rename a campaign in Instantly and the name follows on
// the next lookup, on the UTM path and the reverse-match path alike, because
// both now read it from the same place.
const CAMPAIGN_SLUG_IDS = {
  'broader-church-p1':       'a2a95058-21b8-41c4-8c39-a340976e66d3',
  'broader-church-p2':       'e95713bc-1d2d-4d8b-8475-c1a77771ba8c',
  'broader-church-p3':       '36208b29-d2b3-43d1-80d4-3f708a71f4f7',
  'il-outreach-uncontacted': 'e16e3d42-d3bc-40ce-88e8-756b2aa79ee8',
  'il-outreach-contacted':   '91d40546-b245-4b04-9de5-a8c863a20f3a',
  'tx-nsgp-church':          '7aaa795e-b7c8-462b-8d32-d3603b22cf3d',
  'tx-fy26-deadline':        '3a969ab7-44ad-4768-a82b-12f5e2596662',
  'christian-schools':       '5512076f-4e51-4c44-b032-2cc11dff2d66',
  'facility-security':       '5389e537-6c16-42fd-937d-b0d464703bbc',
  'ca-csnsgp-fy26':          '28c9205e-23fe-4e10-b5fc-839cb2e9f0ab',
  'xp-campaign':             '26dde45b-476d-4571-a3e5-652d006aeb82',
  'iowa-schools':            '26c27e7d-1651-4d39-8206-c2c2cdb63392',
  'remarket-fy27':           '8552c05f-c927-48ee-b654-66f33e1c5cf1',
  // Remarket FY27 sends under two slugs. Unmapped, this one titled itself into
  // "NPSA Church Outreach" -- a campaign Instantly has never had -- and took a
  // booking with it, so one campaign showed up as two and neither total was right.
  'npsa-church-outreach':    '8552c05f-c927-48ee-b654-66f33e1c5cf1',
};

// Last resort, and only when Instantly cannot be reached at all: the names as
// Instantly held them when this was written. Spelled with the hyphens Instantly
// actually uses, so an outage degrades to a name that still GROUPS with the live
// one rather than inventing a fourteenth variant of it.
const CAMPAIGN_SLUG_FALLBACK = {
  'broader-church-p1':       'Broader Church Campaign - Phase 1',
  'broader-church-p2':       'Broader Church Campaign - Phase 2',
  'broader-church-p3':       'Broader Church Campaign - Phase 3 (May 2026)',
  'il-outreach-uncontacted': 'IL Outreach - Uncontacted',
  'il-outreach-contacted':   'IL Outreach - Contacted',
  'tx-nsgp-church':          'TX NSGP - Church - Campaign - 11.11.2025',
  'tx-fy26-deadline':        'TX Campaign - FY2026 Deadline Push',
  'christian-schools':       'Christian Schools Campaign',
  'facility-security':       'Facility and Security Campaign',
  'ca-csnsgp-fy26':          'CA Outreach - CSNSGP FY26',
  'xp-campaign':             'XP Campaign 11.5.2025',
  'iowa-schools':            'Iowa Schools',
  'remarket-fy27':           'Remarket FY27 - Non-Repliers',
  'npsa-church-outreach':    'Remarket FY27 - Non-Repliers',
};

// Campaign names Instantly no longer returns, because the campaign was renamed
// under them. A booking enriched before the rename kept the old name, and one
// enriched before instantly_campaign_id existed kept no id at all -- so it groups
// on its own row, and the id backfill can never rescue it: the backfill resolves
// the stored name against Instantly's CURRENT names, which by definition no longer
// include this one. That is a repair query selecting rows it cannot repair, the
// same shape as the NEEDS_LEAD_DATE condition deleted below.
//
// Mapping the dead name to the id is what lets those rows converge. The name they
// then display comes from Instantly and stays correct through the next rename;
// only the id is asserted here, and an id cannot drift.
const CAMPAIGN_DEAD_NAMES = {
  'remarket fy27 - non-repliers (excl il, ca)': '8552c05f-c927-48ee-b654-66f33e1c5cf1',
  'ca outreach - csnsgp fy26 (6-step)':         '28c9205e-23fe-4e10-b5fc-839cb2e9f0ab',
  'il outreach - uncontacted (6-step)':         'e16e3d42-d3bc-40ce-88e8-756b2aa79ee8',
};

const deadNameToId = (name) =>
  CAMPAIGN_DEAD_NAMES[(name || '').trim().toLowerCase()] || null;

// Tokens that stay upper-case when a slug is titled: the grant programs, and any
// two-letter token, since campaigns are routinely cut by state (ca, tx, il).
const SLUG_UPPER = new Set(['npsa', 'nsgp', 'csnsgp', 'fnpsg', 'xp']);

const titleFromSlug = (slug) =>
  slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((t) => {
      if (SLUG_UPPER.has(t) || t.length === 2) return t.toUpperCase();
      const fy = /^fy(\d{2,4})$/.exec(t);
      if (fy) return `FY${fy[1]}`;
      return t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join(' ');

// Neither map is a requirement. An unmapped slug used to render raw —
// "remarket-fy27" sat in the campaign column looking like a bug — which meant
// every new campaign needed a deploy before it read properly. Titling the slug
// keeps a campaign launched this morning legible this morning; mapping it adds
// the exact wording, and mapping it BY ID keeps that wording correct after a
// rename. Each step down is worse than the one above it, never wrong outright.
async function slugToCampaign(slug) {
  const key = (slug || '').trim().toLowerCase();
  if (!key) return { id: null, name: slug || null };
  // Instantly first, always, so this path and the reverse-match path spell the
  // same campaign the same way. Everything below it is a degradation.
  const id = CAMPAIGN_SLUG_IDS[key] || null;
  if (id) {
    const map = await instantlyCampaignMap();
    if (map[id]) return { id, name: map[id] };
  }
  // The id is still returned when the name could not be resolved: grouping keys on
  // the id, so a booking taken during an Instantly outage still lands in the right
  // row even though the name it displays came from the fallback.
  return { id, name: CAMPAIGN_SLUG_FALLBACK[key] || titleFromSlug(key) };
}

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
    -- The campaign NAME was the only thing stored, so renaming a campaign in
    -- Instantly stranded every earlier booking under the old name for good: three
    -- dead names held 63 bookings between them. The id is what actually identifies
    -- a campaign, and grouping keys on it.
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT;
    -- When the Instantly lead this booking was matched to was created. A lead that
    -- postdates the booking cannot be why it was booked, and recording the date is
    -- what lets that be checked later rather than only at the moment of matching.
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attribution_lead_at TIMESTAMPTZ;
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
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS exclusion_reason TEXT;
  `).catch(err => console.error('bookings disposition-columns error:', err.message));

  // Calendly does not move a meeting when someone reschedules it: it cancels the
  // invitee and creates a brand new one, on a brand new event, with no shared key
  // between them. Ingest sees the second one arrive and has nothing to tie it to
  // the first, so a move reads on the dashboard as a fresh booking sitting beside
  // a cancellation. These two columns hold the link in both directions.
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_from INTEGER;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_to   INTEGER;
  `).catch(err => console.error('bookings reschedule-columns error:', err.message));

  // The date a rescheduled appointment is credited to (see ORIGINATED). Settled for
  // every chain on each boot, which is also the backfill for the chains that were
  // already linked when this column arrived.
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS originated_on TIMESTAMPTZ;
  `).catch(err => console.error('bookings originated-column error:', err.message));
  await resolveOrigins(pool).catch(err => console.error('bookings origin-backfill error:', err.message));

  // When we last asked Calendly to identify a booking that arrived without its
  // identifiers. Recorded so a row Calendly genuinely cannot place — a hand-entered
  // booking, a test row — is retried occasionally rather than on every sweep.
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS calendly_lookup_at TIMESTAMPTZ;
  `).catch(err => console.error('bookings lookup-column error:', err.message));

  // Added after sf_financials existed in prod.
  await pool.query(`
    ALTER TABLE sf_financials ADD COLUMN IF NOT EXISTS contract_id     TEXT;
    ALTER TABLE sf_financials ADD COLUMN IF NOT EXISTS contract_number TEXT;
  `).catch(err => console.error('sf_financials contract-columns error:', err.message));

  // exclusion_reason supersedes the unqualified flag: one booking can be set aside
  // for more than one reason, and "which reason" is worth knowing — a run of double
  // bookings is a scheduling problem, a run of unqualified is a targeting problem.
  // The old boolean is left in place rather than dropped, so a rollback still reads
  // a coherent table; nothing writes to it any more.
  await pool.query(`
    UPDATE bookings SET exclusion_reason = 'unqualified'
     WHERE unqualified = TRUE AND exclusion_reason IS NULL;
  `).catch(err => console.error('bookings exclusion-migration error:', err.message));

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

  // Salesforce Financials (Financials__c) — the authoritative record of money.
  //
  // Every sale creates a contract and a financial record against the same
  // opportunity, so the two should reconcile. When they disagree the financial
  // record wins, because the failure mode runs the other way: a financial can be
  // attached to the wrong opportunity (Central Wesleyan's contract sat on the
  // closed-lost one of two), and any total that qualifies revenue by the
  // opportunity's stage then drops real money on the floor. The financial record
  // itself is never "lost" — it exists because a contract was signed.
  //
  // Opportunity fields are carried along not to filter revenue but to check it:
  // the stage, the won flag and the account are what the data-quality panel
  // compares. Nothing here should ever gate a total on opportunity_stage.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sf_financials (
      financial_id           TEXT PRIMARY KEY,
      name                   TEXT,
      purpose                TEXT,
      amount                 NUMERIC DEFAULT 0,
      upfront                NUMERIC DEFAULT 0,
      implementation         NUMERIC DEFAULT 0,
      created_date           TIMESTAMPTZ,
      opportunity_id         TEXT,
      opportunity_name       TEXT,
      opportunity_stage      TEXT,
      opportunity_is_won     BOOLEAN,
      opportunity_account_id TEXT,
      non_security           BOOLEAN DEFAULT FALSE,
      account_id             TEXT,
      organization           TEXT,
      domain                 TEXT,
      -- Financials__c has its own Contract lookup, and the contract number is what
      -- a person searches Salesforce by. Carried so a flagged record can be opened
      -- rather than hunted for: "Central Wesleyan, $137,500" identifies the problem,
      -- "contract 00000891" identifies the record.
      contract_id            TEXT,
      contract_number        TEXT,
      booking_id             INTEGER,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('sf_financials schema error:', err.message));

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

  // One row per sync attempt, whatever did the syncing. Declared here as well as in
  // the Salesforce connector because both write to it, and this module cannot import
  // that one — the connector already imports from here, so the dependency only goes
  // one way. CREATE IF NOT EXISTS makes whichever runs first the one that matters.
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
}

// ─────────────────────────────────────────────────────────────
// 3. Instantly reverse-match helpers (best-effort, fail safe)
//    NOTE for dev: verify these v2 paths/field names against the
//    Instantly API docs; if they differ, only the reverse-match is
//    affected — UTM attribution keeps working regardless.
// ─────────────────────────────────────────────────────────────
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
let _campaignCache = { at: 0, map: {} };
// A booking whose campaign id was never filled in. Grouping and the campaign
// name both come from it now, so a row without one is still carrying whatever
// Instantly called that campaign at the time it was enriched.
//
// Declared once because it has to hold in BOTH places that enrich. It used to
// live only in the Refresh path, and Refresh bails out when a sweep is already
// running -- so a redeploy, whose startup sweep takes the lock 60 seconds after
// boot, could swallow a Refresh whole: ok: true, nothing queried, nothing said.
const NEEDS_CAMPAIGN_ID = `(instantly_campaign IS NOT NULL AND instantly_campaign_id IS NULL)`;

// NEEDS_LEAD_DATE is gone. It selected reverse-matched rows whose matched lead was
// undated or postdated the booking, to drive the #164/#165 repair -- and that repair
// rested on a premise that is false: a lead MOVED between campaigns keeps its
// original timestamp_created, so it never postdates the booking and the rule never
// fires. What the condition actually did was re-run the reverse lookup over ~70 rows
// and re-credit each to wherever its lead had been moved since. It made the damage
// worse, not better (Remarket 79 -> 91).
//
// It cannot survive sticky attribution in any case. The sticky path deliberately
// does not consult a lead, so it never writes attribution_lead_at -- rows with a
// null one would match this on every sweep for ever, with nothing able to fix them.

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

/**
 * Drop leads created after the booking was made, then take the most recent of what
 * is left.
 *
 * "Most recent lead wins" is right until somebody runs a remarketing campaign.
 * Remarket FY27 - Non-Repliers was created on 27 July 2026 and enrolled the people
 * who had not replied to the earlier campaigns, so those people are leads twice
 * over. Re-enriching a booking taken in March then found the July lead and moved
 * the credit: Phase 1 fell 43 to 15, Christian Schools 41 to 20, Phase 3 31 to 20,
 * and Remarket went 9 to 79 on work the other three had done.
 *
 * An email sent after somebody booked cannot be why they booked. That is the whole
 * rule. Leads with no creation date are kept, because an unknown date is not
 * evidence of anything, and a booking with no booked_on constrains nothing.
 */
const leadNotAfter = (leads, bookedOn) => {
  if (!bookedOn) return leads;
  const cutoff = new Date(bookedOn).getTime();
  if (!Number.isFinite(cutoff)) return leads;
  const eligible = leads.filter((l) => {
    if (!l.timestamp_created) return true;
    const t = new Date(l.timestamp_created).getTime();
    return !Number.isFinite(t) || t <= cutoff;
  });
  // If every lead postdates the booking the person still came from somewhere, and
  // the oldest of them is the closest thing to an answer -- better than reporting
  // no campaign for a booking that plainly came through one.
  return eligible.length ? eligible : leads.slice().reverse();
};

// Best lead for an email that could actually have caused the booking, or null.
async function instantlyFindLead(email, bookedOn) {
  return leadNotAfter(await instantlyLeadsForEmail(email), bookedOn)[0] || null;
}

// Recover a campaign from the booker's last name plus their organisation.
//
// This one attributes revenue to a campaign on the strength of a name and a
// string comparison, so it has to be the strictest of the three, and it was the
// loosest. It accepted `target.includes(c)` with no floor on the length of `c`,
// which means an Instantly lead whose company_name was "Grace" claimed every
// booking from a "Grace ..." anything -- Grace Community Church, Grace Point,
// Grace Baptist -- whichever the search happened to return first. It also never
// checked that the lead it matched was even the person searched for:
// /leads/list is fuzzy across name, email and company, so searching "Reeve"
// returns leads that merely contain "reeve" somewhere.
//
// The rules below are the ones the letters join in this file already uses, for
// the same problem on the same kind of names: an exact normalised match always
// counts, a substring only counts when BOTH sides are at least 6 alphanumerics,
// and an exact match outranks a substring rather than losing to whatever came
// back first.
async function instantlyFindLeadByNameOrg(lastName, org, bookedOn) {
  if (!process.env.INSTANTLY_API_KEY || !lastName) return null;
  const data = await instantlyApi('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: lastName, limit: 20 }),
  });
  const items = (data && (data.items || data.leads)) || [];
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(org);
  const wantLast = norm(lastName);
  if (!target || !wantLast) return null;

  const MIN = 6; // below this a substring is a coincidence, not a match
  const scored = items
    .filter((l) => l.campaign || l.campaign_id)
    // The search is fuzzy, so confirm the lead is actually this person before
    // letting their campaign speak for the booking.
    .filter((l) => {
      const name = norm(`${l.first_name || ''}${l.last_name || ''}`) || norm(l.name);
      return name.includes(wantLast);
    })
    .map((l) => ({ l, c: norm(l.company_name) }))
    .filter(({ c }) => c && (
      c === target ||
      (c.length >= MIN && target.length >= MIN && (c.includes(target) || target.includes(c)))
    ))
    .sort((a, b) =>
      // Exact first, then the longer company name: "First Lutheran Church of
      // Cedar Falls" is a better claim on "First Lutheran Church" than "First".
      (b.c === target) - (a.c === target) || b.c.length - a.c.length);

  // Same cut-off as the email matcher: a lead added after the booking cannot
  // explain it, however well the organisation name lines up.
  const hit = leadNotAfter(scored.map((x) => x.l), bookedOn)[0];
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
async function instantlyFindLeadByDomain(domain, bookedOn) {
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
  return leadNotAfter(matches, bookedOn)[0] || null;
}

/**
 * Every Instantly campaign that could plausibly account for this booking, with the
 * evidence for each — for a person to choose between, not for the app to apply.
 *
 * The automatic chain above asks the same questions but insists on one winner, and
 * gives up silently when nothing matches cleanly. Its org test needs the company
 * name to contain the booking's organisation or vice versa, which church names
 * rarely survive: "First Lutheran Church" and "First Lutheran Church of Cedar
 * Falls" pass, "FLC Cedar Falls" does not. That is what leaves a booking reading
 * "Instantly – campaign unknown" while somebody works it out by hand from the
 * church name and the person who booked.
 *
 * So the searches are run wider and every hit is kept rather than reduced to a
 * winner. A half-matching name is worth showing and not worth assigning — narrowing
 * is cheap for a machine, judging is cheap for a person, and this hands each the
 * half it is good at.
 */
async function instantlySearchLeads(term, limit = 50) {
  if (!process.env.INSTANTLY_API_KEY || !term) return [];
  const data = await instantlyApi('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: String(term).trim(), limit }),
  });
  return ((data && (data.items || data.leads)) || [])
    .map((l) => ({ ...l, campaign: l.campaign || l.campaign_id || null }))
    .filter((l) => l.campaign);
}

const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function instantlyCampaignCandidates(row) {
  const email = (row.email || '').trim().toLowerCase();
  const domain = (email.split('@')[1] || '').replace(/^www\./, '');
  const lastName = (row.name || '').trim().split(/\s+/).pop() || '';
  const org = (row.organization || '').trim();

  // Each probe carries its own test, because Instantly's search is fuzzy across
  // several fields — searching a domain returns people whose NAME contains it.
  const probes = [
    email && { term: email, why: 'same email address',
      hit: (l) => (l.email || '').trim().toLowerCase() === email },
    domain && !FREEMAIL.has(domain) && { term: domain, why: 'same email domain',
      hit: (l) => [(l.email || '').split('@')[1], l.company_domain]
        .some((d) => (d || '').toLowerCase().replace(/^www\./, '') === domain) },
    org && { term: org, why: 'similar organisation',
      hit: (l) => {
        const c = normName(l.company_name), t = normName(org);
        return Boolean(c && t && (c.includes(t) || t.includes(c)));
      } },
    lastName && { term: lastName, why: 'same last name',
      hit: (l) => normName(l.last_name) === normName(lastName) },
  ].filter(Boolean);

  const byCampaign = new Map();
  for (const probe of probes) {
    let leads = [];
    // One failing probe must not lose the others — a partial answer beats none.
    try { leads = await instantlySearchLeads(probe.term); } catch { continue; }
    for (const lead of leads) {
      if (!probe.hit(lead)) continue;
      const entry = byCampaign.get(lead.campaign)
        || { campaign_id: lead.campaign, why: new Set(), leads: new Map() };
      entry.why.add(probe.why);
      entry.leads.set(lead.id || `${lead.email}|${lead.campaign}`, {
        name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
        email: lead.email || null,
        company: lead.company_name || null,
      });
      byCampaign.set(lead.campaign, entry);
    }
  }

  const map = await instantlyCampaignMap();
  const named = [], unnamed = [];
  for (const e of byCampaign.values()) {
    const shaped = {
      campaign: map[e.campaign_id] || null,
      campaign_id: e.campaign_id,
      why: [...e.why],
      lead_count: e.leads.size,
      examples: [...e.leads.values()].slice(0, 3),
    };
    (shaped.campaign ? named : unnamed).push(shaped);
  }
  named.sort((a, b) => b.lead_count - a.lead_count || a.campaign.localeCompare(b.campaign));
  // A campaign the map cannot name is reported rather than dropped: it means the
  // campaign list is stale or the campaign was archived, and that is a reason
  // attribution fails silently everywhere else too.
  return { suggestions: named, unnamed_campaign_ids: unnamed.map((u) => u.campaign_id) };
}

// Exported for scripts/test-instantly-match.js (kept out of the app's behaviour).
export { instantlyCampaignMap, instantlyLeadsForEmail, instantlyFindLead };

// ─────────────────────────────────────────────────────────────
// 4. Calendly held-status (best-effort, fail safe)
// ─────────────────────────────────────────────────────────────
// Why a booking is set aside. One booking, one reason — but which reason matters:
// a run of double bookings is a scheduling problem, a run of unqualified is a
// targeting problem, and they want telling apart.
// 'rescheduled' is derived rather than chosen — it is what a cancellation turns out
// to have been once the replacement booking arrives and points back at it. It is
// listed here so the reason survives validation and reads properly in the UI, but
// nothing asks a person to pick it.
const EXCLUSION_REASONS = ['unqualified', 'double_booking', 'cancelled', 'rescheduled'];
const EXCLUSION_LABELS = {
  unqualified: 'Unqualified',
  double_booking: 'Double booking',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
};
export { EXCLUSION_REASONS, EXCLUSION_LABELS };

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
//   oldInvitee — the invitee this one replaced, when the booking is a reschedule.
//                Calendly only records the link on the invitee, so answering it
//                costs the same second API call attendance does.
//
//   host       — the rep who owns the meeting, read from the event's first
//                membership. It costs nothing: this function already fetches the
//                scheduled event, and event_memberships sits in the same response
//                that status is read from. Until now that field was thrown away,
//                and the ONLY thing that ever wrote bookings.host was whatever the
//                Zap happened to post at ingest — so a booking that arrived without
//                one stayed blank for ever, since nothing re-asked. Calendly is the
//                authority on who is hosting; ask it.
//
// checkAttendance skips the second API call for events that have not happened yet;
// checkReschedule asks for it anyway while the link is still unknown, because a
// move usually lands on a date in the future and would otherwise go unnoticed until
// after the meeting.
//
// Returns null for anything it cannot determine, so a missing token or a Calendly
// outage leaves existing values untouched rather than overwriting them.
async function calendlyStatus(eventUri, { checkAttendance = false, checkReschedule = false } = {}) {
  const unknown = { cancelled: null, held: null, source: null, oldInvitee: null, host: null };
  const key = process.env.CALENDLY_API_TOKEN;
  if (!key || !eventUri) return unknown;
  try {
    const ev = await fetch(eventUri, { headers: { Authorization: `Bearer ${key}` } });
    if (!ev.ok) return unknown;
    const resource = (await ev.json())?.resource;
    const status = resource?.status;
    // A round robin has one membership; a collective event lists everyone, and the
    // first is the owner — the same choice the Calendly backfill makes, so a booking
    // reads the same host whichever path imported it.
    const base = { ...unknown, host: (resource?.event_memberships || [])[0]?.user_email || null };
    // A cancellation says nothing about attendance, so it deliberately leaves held
    // alone. Writing held=false here was the original conflation, and it stuck: an
    // event cancelled and then reinstated kept "not held" forever, because a future
    // meeting has no attendance to re-read. Cancelled rows are excluded from the
    // counts anyway, so there is nothing to gain by answering a question nobody asked.
    //
    // A rescheduled-away event is cancelled too, and its own invitee carries the
    // forward pointer — but that link is read from the replacement's side instead,
    // so this path stays a single API call.
    if (status === 'canceled') return { ...base, cancelled: true };
    if (status !== 'active') return base;
    if (!checkAttendance && !checkReschedule) return { ...base, cancelled: false };
    const inv = await fetch(`${eventUri}/invitees`, { headers: { Authorization: `Bearer ${key}` } });
    if (!inv.ok) return { ...base, cancelled: false };
    const first = ((await inv.json()).collection || [])[0];
    const oldInvitee = (checkReschedule && first?.old_invitee) || null;
    if (!checkAttendance || !first) return { ...base, cancelled: false, oldInvitee };
    return { ...base, cancelled: false, held: !first.no_show, source: 'calendly', oldInvitee };
  } catch {
    return unknown;
  }
}

/** `.../scheduled_events/EVT/invitees/INV` → `.../scheduled_events/EVT`. */
const eventUriOfInvitee = (uri) => {
  const trimmed = (uri || '').replace(/\/invitees\/[^/]+\/?$/, '');
  return trimmed && trimmed !== uri ? trimmed : null;
};

// ─────────────────────────────────────────────────────────────
// 4b. Calendly backfill — import bookings that were never captured
//
// A Calendly link only starts feeding the dashboard the day someone wires a Zap to
// it, and everything booked before that is invisible. Rather than exporting a file
// and posting it back, this asks Calendly for the history directly: the token is
// already here, the answer is authoritative, and there is no snapshot to go stale.
//
// Questions are matched by NAME, not position. The Zap has to map them positionally
// (1_answer, 3_answer), which silently breaks whenever a form's question order
// differs — reordering a Calendly form is a two-second drag with no warning that it
// has repointed an integration. Matching on the question text cannot be reordered
// out of correctness.
// ─────────────────────────────────────────────────────────────
const CAL_API = 'https://api.calendly.com';

async function calendlyGet(path) {
  const key = process.env.CALENDLY_API_TOKEN;
  if (!key) throw new Error('CALENDLY_API_TOKEN is not set');
  const url = path.startsWith('http') ? path : `${CAL_API}${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Calendly ${r.status} on ${url.replace(CAL_API, '')}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Finds an answer by what the question asks rather than where it sits.
// Takes the array, not the invitee, so a caller cannot pass the wrong property and
// get silence: the field is questions_and_ANSWERS, and an earlier version read
// questions_and_responses. That property does not exist, so every lookup returned
// null — a wrong field name wearing the disguise of a form that asks nothing.
const answerMatching = (qs, re) => {
  if (!Array.isArray(qs)) throw new Error('expected an array of questions and answers');
  const hit = qs.find(q => re.test(String(q.question || '')));
  const a = hit?.answer;
  return (Array.isArray(a) ? a.join(', ') : (a || '')).trim() || null;
};

// Shared with the pre-call notes generator, which reads the same events and the
// same question/answer shape. One reader of Calendly's quirks, not two.
export { calendlyGet, answerMatching, calendlyStatus };

let _calOrg = null;
const calendlyOrg = async () => (_calOrg ??= (await calendlyGet('/users/me')).resource.current_organization);

/**
 * Finds the Calendly event a booking came from, using only what the booking has.
 *
 * Not every row arrives carrying Calendly's own identifiers — whether one does
 * depends on how it was captured, and a row without them can never be asked about
 * attendance, cancellation or a reschedule. It stays unresolved for ever, and looks
 * on the dashboard exactly like a meeting nobody has got round to marking.
 *
 * Who attended and when is enough to find it again: Calendly will filter its own
 * events by invitee email, and a start time identifies which of that person's
 * meetings this is. The window is for clock skew, not for guessing — a candidate
 * more than a minute off the recorded time is a different meeting and is refused,
 * because a wrong match here would attach one meeting's attendance to another.
 *
 * Cancelled events are deliberately included. The row that most needs finding is
 * the one whose meeting was called off, since that is the fact nobody recorded.
 */
async function findCalendlyEvent(email, meetingDate) {
  if (!process.env.CALENDLY_API_TOKEN) return null;
  const wanted = String(email || '').trim().toLowerCase();
  const at = new Date(meetingDate);
  if (!wanted || isNaN(at)) return null;

  const pad = 2 * 60 * 60 * 1000;
  const qs = new URLSearchParams({
    organization: await calendlyOrg(),
    invitee_email: wanted,
    min_start_time: new Date(at.getTime() - pad).toISOString(),
    max_start_time: new Date(at.getTime() + pad).toISOString(),
    count: '20',
  });
  const events = (await calendlyGet(`/scheduled_events?${qs}`)).collection || [];
  if (!events.length) return null;

  const closest = events.reduce((best, e) =>
    Math.abs(new Date(e.start_time) - at) < Math.abs(new Date(best.start_time) - at) ? e : best);
  if (Math.abs(new Date(closest.start_time) - at) > 60_000) return null;

  const invitees = (await calendlyGet(`${closest.uri}/invitees`)).collection || [];
  const inv = invitees.find(i => String(i.email || '').toLowerCase() === wanted) || invitees[0];
  return { eventUri: closest.uri, inviteeUri: inv?.uri || null };
}

async function backfillCalendly(pool, { eventType, since, dryRun }) {
  const me = await calendlyGet('/users/me');
  const org = me.resource.current_organization;

  // Calendly's list-events endpoint takes organization, user, status and a date
  // range — and no event type. Passing one is accepted and silently ignored, so a
  // request that looks filtered comes back with every event type in the org. The
  // first version of this did exactly that: it reported 360 events for a link with
  // 103, and the extras were other event types whose forms ask different questions,
  // which read as a mapping failure rather than the wrong query. So filter here,
  // and before fetching invitees — that is one API call per event, and fetching
  // them for events we are about to discard is most of the runtime.
  const all = [];
  let next = `${CAL_API}/scheduled_events?organization=${encodeURIComponent(org)}`
    + (since ? `&min_start_time=${encodeURIComponent(new Date(since).toISOString())}` : '')
    + '&count=100&sort=start_time:asc';
  while (next) {
    const page = await calendlyGet(next);
    all.push(...(page.collection || []));
    next = page.pagination?.next_page || null;
  }
  const events = all.filter(e => e.event_type === eventType);

  const result = {
    scanned: events.length,
    of_all_event_types: all.length,   // so a filter that matched nothing is obvious
    ingested: 0, skipped: 0, failed: 0,
    // How many records actually yielded an organization. Every one coming back
    // empty is the signature of reading the wrong field or the wrong events, and
    // it is worth stating as a number rather than leaving to be noticed in a
    // sample — both times this endpoint was wrong, that was the visible symptom.
    with_organization: 0,
    sample: [],
  };
  if (!events.length) {
    result.note = `no events matched ${eventType} — check the event type id`;
    return result;
  }
  // A dry run only has to prove the mapping reads the right answers, and that is
  // visible from a handful of records. Fetching invitees for all of them turns a
  // preview into a two-minute wait, which is how the first attempt hit a timeout.
  const toRead = dryRun ? events.slice(0, 5) : events;
  for (const ev of toRead) {
    try {
      const invitees = (await calendlyGet(`${ev.uri}/invitees`)).collection || [];
      const inv = invitees[0];
      if (!inv) { result.skipped++; continue; }
      const qs = inv.questions_and_answers || [];
      const booking = {
        calendly_uri: inv.uri,
        event_uri: ev.uri,
        booked_on: inv.created_at || null,
        meeting_date: ev.start_time || null,
        name: inv.name || null,
        email: inv.email || null,
        organization: answerMatching(qs, /organi[sz]ation|company/i),
        told_us: answerMatching(qs, /hear about/i),
        utm_source: inv.tracking?.utm_source || null,
        utm_medium: inv.tracking?.utm_medium || null,
        utm_campaign: inv.tracking?.utm_campaign || null,
        host: (ev.event_memberships || [])[0]?.user_email || null,
      };
      if (booking.organization) result.with_organization++;
      if (result.sample.length < 5) {
        result.sample.push({ organization: booking.organization, name: booking.name,
          meeting_date: booking.meeting_date, told_us: booking.told_us, status: ev.status });
      }
      if (dryRun) continue;   // ingested counts writes, and a dry run makes none
      const id = await upsertBooking(pool, booking);
      await enrichBooking(pool, id);   // sets channel, held, and cancelled from Calendly
      result.ingested++;
    } catch (e) {
      result.failed++;
      console.error('[calendly-backfill]', ev.uri, e.message);
    }
  }
  return result;
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
  social: 'Social', referral: 'Referral', conference: 'Conference', linkedin: 'LinkedIn',
  past_engaged_prospect: 'Past Engaged Prospect', direct: 'Direct / Other',
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
  // Attribution is STICKY. A reverse lookup fills a gap; it never revises an answer.
  //
  // The reverse matchers (email, name+org, domain) all resolve to "whichever campaign
  // that lead sits in RIGHT NOW". Leads get MOVED between campaigns routinely, and
  // Instantly moves rather than copies -- one lead record, whose timestamp_created
  // keeps the ORIGINAL import date. So the campaign field on a lead means "where this
  // person lives today", not "which campaign emailed them". Re-enriching an old
  // booking therefore re-credited it to wherever its lead had since been moved, and
  // every refresh dragged more of the back catalogue onto the newest remarketing
  // campaign: Phase 1 43 -> 18, Christian Schools 41 -> 26, Remarket 9 -> 91, on work
  // the earlier campaigns had done.
  //
  // Dating the lead cannot catch this (#164 tried) precisely because a moved lead
  // keeps its original date, so the booking never looks newer than the lead.
  //
  // What actually holds is refusing to overwrite. Only two things may change a
  // campaign that is already recorded:
  //   utm      -- contemporaneous, embedded in the email that was really clicked
  //   manual   -- a person looked and decided
  // Both are handled below and both still win. Everything else keeps what is there.
  //
  // leadAt distinguishes three states: a real date, '-infinity' for a lead Instantly
  // gave no date for, and null for "never matched a lead". It is carried forward
  // untouched on the sticky path so a re-enrich cannot blank it.
  let campaign = null, campaignId = null, leadAt = null, source = 'none';
  const hasCampaign = !!(row.instantly_campaign || row.instantly_campaign_id);
  if ((row.utm_source || '').toLowerCase() === 'instantly' && row.utm_campaign) {
    ({ id: campaignId, name: campaign } = await slugToCampaign(row.utm_campaign));
    source = 'utm';
  } else if (hasCampaign) {
    // Keep what is already recorded, including the source that set it -- overwriting
    // that with a marker would destroy the only record of how each row was decided,
    // which is what makes the damage auditable.
    campaign = row.instantly_campaign;
    campaignId = row.instantly_campaign_id;
    leadAt = row.attribution_lead_at;
    source = row.attribution_source || 'none';
    // Filling in the other half of the pair is not a revision -- name and id denote
    // the same campaign, so resolving one from the other cannot move a booking. It is
    // also what retires NEEDS_CAMPAIGN_ID now that a reverse lookup no longer runs
    // here to set the id as a side effect. The map is cached, so this costs no call.
    if (campaign && !campaignId) {
      const map = await instantlyCampaignMap();
      campaignId = Object.keys(map).find((k) => map[k] === campaign)
        || deadNameToId(campaign) || null;
    } else if (campaignId && !campaign) {
      const map = await instantlyCampaignMap();
      campaign = map[campaignId] || null;
    }
  } else {
    // Each branch records the id it matched on as well as the name, because the id
    // is what the campaign actually is. A name resolving to null here used to end
    // the chain silently -- a lead in a campaign the workspace no longer lists
    // looked exactly like a lead in no campaign at all.
    const lead = await instantlyFindLead(row.email, row.booked_on);
    if (lead?.campaign) {
      const map = await instantlyCampaignMap();
      campaignId = lead.campaign;
      leadAt = lead.timestamp_created || '-infinity';
      campaign = map[lead.campaign] || null; source = 'reverse_email';
    }
    if (!campaignId) {
      const last = (row.name || '').trim().split(/\s+/).pop();
      const lead2 = await instantlyFindLeadByNameOrg(last, row.organization, row.booked_on);
      if (lead2?.campaign) {
        const map = await instantlyCampaignMap();
        campaignId = lead2.campaign;
        leadAt = lead2.timestamp_created || '-infinity';
        campaign = map[lead2.campaign] || null; source = 'reverse_name_org';
      }
    }
    if (!campaignId) {
      const lead3 = await instantlyFindLeadByDomain((row.email || '').split('@')[1], row.booked_on);
      if (lead3?.campaign) {
        const map = await instantlyCampaignMap();
        campaignId = lead3.campaign;
        leadAt = lead3.timestamp_created || '-infinity';
        campaign = map[lead3.campaign] || null; source = 'reverse_domain';
      }
    }
  }
  // A person can overrule the derived channel, and that is the only way to correct a
  // booking the reverse-match got wrong — someone who happens to sit in an Instantly
  // campaign but actually reached out directly looks identical to a campaign win from
  // here. It is also how a manually added booking keeps the channel it was entered
  // with, since there is no Calendly or UTM data to derive one from.
  let channel = deriveChannel(row, campaign);
  if (override.channel) {
    channel = override.channel;
    source = 'manual';
    if (override.channel !== 'instantly') { campaign = null; campaignId = null; leadAt = null; }
  }
  // Naming the campaign is the stronger statement, so it is applied last and settles
  // the channel with it: a booking cannot be from an Instantly campaign and from
  // some other channel at once. Without this an earlier channel override would win
  // and quietly discard the campaign somebody had just gone and looked up.
  if (typeof override.campaign === 'string' && override.campaign) {
    campaign = override.campaign;
    channel = 'instantly';
    source = 'manual';
    // The picker sends a name, so look its id back up. Without this a booking
    // somebody corrected by hand would be the one row that could not group with
    // the campaign they corrected it TO, the moment that campaign is renamed.
    const map = await instantlyCampaignMap();
    campaignId = Object.keys(map).find((k) => map[k] === campaign) || null;
    leadAt = null;
  }

  // --- Cancelled + held (one Calendly lookup answers both) ---
  // Attendance is only worth asking about once the meeting has passed; cancellation
  // is asked every time, because a future meeting being called off is the whole point.
  // --- Calendly identity, recovered when it is missing ---
  // Held, cancelled and the reschedule link are all one question asked of one
  // event, so a row with no event_uri answers none of them — for ever, however
  // often enrichment runs. Retried on a delay rather than every pass, so a booking
  // Calendly cannot place does not cost two API calls every sweep.
  const LOOKUP_RETRY_MS = 6 * 60 * 60 * 1000;
  let eventUri = row.event_uri;
  let inviteeUri = null;
  let lookupAt = row.calendly_lookup_at;
  const lookupDue = !lookupAt || Date.now() - new Date(lookupAt).getTime() > LOOKUP_RETRY_MS;
  if (!eventUri && row.email && row.meeting_date && lookupDue) {
    lookupAt = new Date();
    try {
      const found = await findCalendlyEvent(row.email, row.meeting_date);
      if (found) {
        eventUri = found.eventUri;
        // calendly_uri is unique, and the invitee we just found may already belong
        // to another row. Leaving it null costs nothing — event_uri answers every
        // question this table asks — whereas colliding would fail the whole write.
        if (found.inviteeUri && !row.calendly_uri) {
          const taken = await pool.query('SELECT 1 FROM bookings WHERE calendly_uri=$1 AND id<>$2',
            [found.inviteeUri, id]);
          if (!taken.rows[0]) inviteeUri = found.inviteeUri;
        }
        console.log(`[marketing] booking ${id} matched to ${found.eventUri}`);
      }
    } catch (e) {
      console.warn(`[marketing] calendly lookup failed for booking ${id}: ${e.message}`);
    }
  }

  const past = row.meeting_date && new Date(row.meeting_date) < new Date();
  const st = await calendlyStatus(eventUri, {
    checkAttendance: Boolean(past),
    // Asked until it is answered, then never again: an invitee's old_invitee is
    // fixed at creation, so a row that already knows its origin costs no calls.
    checkReschedule: row.rescheduled_from == null,
  });

  let cancelled = row.cancelled === true;
  let cancelledAt = row.cancelled_at;
  if (st.cancelled === true && !cancelled) { cancelled = true; cancelledAt = new Date(); }
  else if (st.cancelled === false) { cancelled = false; cancelledAt = null; } // rebooked/reinstated
  // st.cancelled === null means Calendly could not answer — leave what we have.

  let held = row.held, heldSource = row.held_source;
  if (typeof override.held === 'boolean') { held = override.held; heldSource = 'manual'; }
  else if (st.held !== null) { held = st.held; heldSource = st.source; }

  // --- Reschedule link ---
  // Ingest matches on the invitee URI, which a reschedule always changes, so the
  // replacement lands as an unrelated row. Calendly's own pointer is the only thing
  // that ties them together; following it is what turns two disconnected rows into
  // one meeting that moved. Matching the earlier row on either key covers both ingest
  // paths — the Zap fills calendly_uri, the backfill fills both.
  let rescheduledFrom = row.rescheduled_from;
  let rescheduledTo = row.rescheduled_to;
  let linkedNow = false;
  if (rescheduledFrom == null && st.oldInvitee) {
    const prev = await pool.query(
      `SELECT id FROM bookings
        WHERE id <> $3 AND (calendly_uri = $1 OR ($2 <> '' AND event_uri = $2))
        ORDER BY id LIMIT 1`,
      [st.oldInvitee, eventUriOfInvitee(st.oldInvitee) || '', id]
    );
    if (prev.rows[0]) {
      rescheduledFrom = prev.rows[0].id;
      linkedNow = true;
      // The row it replaced is already excluded as a cancellation — Calendly cancels
      // the old event on every reschedule — so this is a relabel, not a new exclusion.
      // A reason a person chose is left alone.
      await pool.query(
        `UPDATE bookings
            SET rescheduled_to = $1,
                exclusion_reason = CASE WHEN exclusion_reason IS NULL OR exclusion_reason = 'cancelled'
                                        THEN 'rescheduled' ELSE exclusion_reason END,
                updated_at = NOW()
          WHERE id = $2`,
        [id, rescheduledFrom]
      );
    }
  }

  // --- Why this booking is set aside, if it is ---
  // A person's choice wins over Calendly, since someone marking a double booking
  // knows something the calendar does not. Calendly's cancellation is the fallback,
  // so a cancelled meeting is excluded even when nobody has touched it — reported as
  // a reschedule once the replacement has been found, since "cancelled" reads as a
  // meeting lost and this one was only moved.
  // rescheduled_to is written by the replacement's enrichment, not this one, so a
  // cancelled row re-reads it rather than trusting the snapshot taken at the top —
  // otherwise two rows enriching in the same sweep can relabel each other in the
  // wrong order and put "cancelled" back on a meeting that only moved.
  if (rescheduledTo == null && cancelled) {
    const fresh = await pool.query('SELECT rescheduled_to FROM bookings WHERE id=$1', [id]);
    rescheduledTo = fresh.rows[0]?.rescheduled_to ?? null;
  }
  const chosen = EXCLUSION_REASONS.includes(override.exclusion) ? override.exclusion : null;
  const exclusionReason = chosen || (cancelled ? (rescheduledTo != null ? 'rescheduled' : 'cancelled') : null);

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

  // host is COALESCEd the other way round from the rest: Calendly's answer WINS and
  // the stored value is only the fallback, because a round robin can be reassigned
  // and the calendar is the truth. It still never blanks a name — st.host is null
  // whenever Calendly was not reached, and null falls through to what is there.
  await pool.query(
    `UPDATE bookings SET
       instantly_campaign=$1, instantly_campaign_id=$17, attribution_lead_at=$18,
       attribution_channel=$2, attribution_source=$3,
       held=$4, held_source=$5, became_client=$6, client_letter_id=$7, fee=$8,
       exclusion_reason=$9, cancelled=$10, cancelled_at=$11, rescheduled_from=$12,
       event_uri=$13, calendly_uri=COALESCE($14, calendly_uri), calendly_lookup_at=$15,
       host=COALESCE($19, host),
       enriched_at=NOW(), updated_at=NOW()
     WHERE id=$16`,
    [campaign, channel, source, held, heldSource, becameClient, letterId, fee,
     exclusionReason, cancelled, cancelledAt, rescheduledFrom,
     eventUri, inviteeUri, lookupAt, id, campaignId, leadAt, st.host]
  );

  // Only now is this row's rescheduled_from on disk, so only now can the chain it
  // just joined be dated from its first booking.
  if (linkedNow) await resolveOrigins(pool);
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
/**
 * Finds the booking an organization's Salesforce record belongs to.
 *
 * Domain first (precise — the same registrable domain on the booking email), then
 * the account name, normalized and BIDIRECTIONAL so a longer, more decorated
 * Salesforce name ("Killian Hill Baptist Church - Christian School - GA") still
 * matches a plainer booking org ("Killian Hill Baptist Church"). Exact normalized
 * names always match; a substring match only counts when BOTH names are at least 6
 * alphanumerics, to keep short strings from matching each other by accident.
 *
 * Shared by wins and financials so an org lands on the same booking either way —
 * two matchers would eventually disagree, and the disagreement would show up as
 * revenue counted twice or attributed to nobody.
 */
async function matchBookingByOrg(pool, domain, org, columns = 'id') {
  if (domain) {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM bookings
         WHERE regexp_replace(lower(split_part(email,'@',2)), '^www\\.', '') = $1
         ORDER BY booked_on DESC NULLS LAST, id DESC
         LIMIT 1`,
      [domain]
    );
    if (rows[0]) return rows[0];
  }
  if (org) {
    const { rows } = await pool.query(
      `WITH q AS (SELECT regexp_replace(lower($1), '[^a-z0-9]', '', 'g') AS t)
       SELECT ${columns.split(',').map(c => `b.${c.trim()}`).join(', ')}
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
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * One financial record from Salesforce.
 *
 * Deliberately stores every record the sync delivers, including ones that will not
 * count: a financial whose purpose is not a new contract, one flagged non-security,
 * one with no opportunity at all. Filtering at write time would make those records
 * invisible, and the whole point of this change is that a record excluded from the
 * total should be visible AS excluded rather than absent. The counting rule lives
 * in COUNTABLE_FINANCIAL, once, where it can be read.
 */
async function recordFinancial(pool, f) {
  const id = (f.financial_id || '').toString().trim();
  if (!id) return { stored: false, reason: 'missing financial_id' };
  const domain = bareDomain(f.domain);
  const org = (f.organization || '').trim();
  const booking = await matchBookingByOrg(pool, domain, org);

  await pool.query(
    `INSERT INTO sf_financials (
       financial_id, name, purpose, amount, upfront, implementation, created_date,
       opportunity_id, opportunity_name, opportunity_stage, opportunity_is_won,
       opportunity_account_id, non_security, account_id, organization, domain,
       contract_id, contract_number, booking_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (financial_id) DO UPDATE SET
       -- A missing value must not erase a known one, for the same reason as sf_wins:
       -- Account.Website is null on plenty of accounts, and overwriting would break
       -- the booking match that depends on it. Money and status always take the
       -- newest value, because those are what the sync exists to keep current.
       name = COALESCE(EXCLUDED.name, sf_financials.name),
       purpose = COALESCE(EXCLUDED.purpose, sf_financials.purpose),
       amount = EXCLUDED.amount,
       upfront = EXCLUDED.upfront,
       implementation = EXCLUDED.implementation,
       created_date = COALESCE(EXCLUDED.created_date, sf_financials.created_date),
       opportunity_id = EXCLUDED.opportunity_id,
       opportunity_name = COALESCE(EXCLUDED.opportunity_name, sf_financials.opportunity_name),
       opportunity_stage = EXCLUDED.opportunity_stage,
       opportunity_is_won = EXCLUDED.opportunity_is_won,
       opportunity_account_id = COALESCE(EXCLUDED.opportunity_account_id, sf_financials.opportunity_account_id),
       non_security = EXCLUDED.non_security,
       account_id = COALESCE(EXCLUDED.account_id, sf_financials.account_id),
       organization = COALESCE(EXCLUDED.organization, sf_financials.organization),
       domain = COALESCE(EXCLUDED.domain, sf_financials.domain),
       contract_id = COALESCE(EXCLUDED.contract_id, sf_financials.contract_id),
       contract_number = COALESCE(EXCLUDED.contract_number, sf_financials.contract_number),
       booking_id = COALESCE(EXCLUDED.booking_id, sf_financials.booking_id),
       updated_at = NOW()`,
    [id, f.name || null, f.purpose || null, Number(f.amount) || 0,
     Number(f.upfront) || 0, Number(f.implementation) || 0, f.created_date || null,
     f.opportunity_id || null, f.opportunity_name || null, f.opportunity_stage || null,
     typeof f.opportunity_is_won === 'boolean' ? f.opportunity_is_won : null,
     f.opportunity_account_id || null, f.non_security === true,
     f.account_id || null, org || null, domain || null,
     f.contract_id || null, f.contract_number || null, booking?.id ?? null]
  );
  return { stored: true, id, booking_id: booking?.id ?? null };
}

async function recordWin(pool, w) {
  const opp = (w.opportunity_id || '').toString().trim();
  if (!opp) return { matched: false, reason: 'missing opportunity_id' };
  const domain = bareDomain(w.domain);
  const org = (w.organization || '').trim();
  const amount = Number(w.amount) || 0;
  const wonAt = w.close_date || null;

  // 1) booking that already counts this opportunity → update in place (idempotent).
  let r = await pool.query(`SELECT id, won_opportunities FROM bookings WHERE won_opportunities ? $1 LIMIT 1`, [opp]);
  let target = r.rows[0] || await matchBookingByOrg(pool, domain, org, 'id, won_opportunities');
  // Persist the win itself — EVERY win lands in sf_wins whether or not it maps to a
  // booking (booking_id stays NULL when untracked). Idempotent per opportunity;
  // re-firing refreshes the fields. Once linked to a booking it stays linked unless
  // a later firing matches a different one.
  await pool.query(
    `INSERT INTO sf_wins (opportunity_id, organization, domain, amount, close_date, booking_id)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
     ON CONFLICT (opportunity_id) DO UPDATE
       -- A missing value must not erase a known one. Account.Website is null on
       -- plenty of accounts, so a full sync legitimately carries no domain for
       -- them; overwriting would throw away a domain an earlier load had and
       -- silently break the booking match that depends on it. Same for the name.
       SET organization = COALESCE(EXCLUDED.organization, sf_wins.organization),
           domain = COALESCE(EXCLUDED.domain, sf_wins.domain),
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
export { recordWin, recordFinancial, recordApplication, rebuildBookingWins };

// ─────────────────────────────────────────────────────────────
// 8. Routes
// ─────────────────────────────────────────────────────────────
// Every dashboard count uses this one predicate, so "how many bookings" has exactly
// one answer no matter which tile is asking. An unqualified or cancelled booking is
// still a row in the table and still appears in the list — it is removed from the
// arithmetic, not from the record.
const COUNTABLE = `exclusion_reason IS NULL`;

// The date an appointment is CREDITED to: the day it was first set, not the day it
// last moved. Calendly does not move a meeting, it cancels it and books a new one,
// so the replacement row's own booked_on is the day of the reschedule. Counting
// that credits the appointment to whichever week or month it was rescheduled in,
// and a reschedule is a change of status on an appointment that already exists,
// not a new one being set. Of the first 13 reschedules this moved 11 into a later
// week and 2 into a later month.
//
// originated_on holds the first booking's date on every row in a reschedule chain
// and is NULL everywhere else, so this is just booked_on unless the row replaced
// another. Every figure that is bucketed by date goes through it.
const ORIGINATED = `COALESCE(originated_on, booked_on)`;

// Weeks and months are counted on NPSA's clock, not the database's. Postgres runs
// in UTC here, so a Sunday-to-Saturday week used to begin at 7 PM Central on
// Saturday (6 PM in winter), and a booking taken on a Saturday evening, or on the
// last evening of a month, was credited to the following week or month. The team
// reads these numbers in Central, so the boundaries are drawn in Central.
//
// AT TIME ZONE turns an instant into Central wall-clock time, and every bucket is
// cut from that. Both sides of a comparison must be converted -- including NOW() --
// or "this week" is a Central week measured against a UTC one.
const REPORT_TZ = 'America/Chicago';
const central = (expr) => `(${expr} AT TIME ZONE '${REPORT_TZ}')`;
// date_trunc('week') starts on MONDAY; shifting a day either side gives Sunday.
const sundayOf = (expr) => `(date_trunc('week', ${expr} + interval '1 day') - interval '1 day')`;
const WEEK_OF_BOOKING = sundayOf(central(ORIGINATED));
const MONTH_OF_BOOKING = `date_trunc('month', ${central(ORIGINATED)})`;
const THIS_WEEK = sundayOf(central('NOW()'));
const THIS_MONTH = `date_trunc('month', ${central('NOW()')})`;

/**
 * Stamps every row in a reschedule chain with the booked_on of the chain's first
 * booking, and clears it from any row that is no longer in one.
 *
 * Recomputed over the whole table rather than patched per link, because links are
 * made in whatever order enrichment reaches the rows: in A -> B -> C, C can be
 * linked to B before B is linked to A, and a per-link update would stamp C with
 * B's date and never come back to it. Walking down from every root settles a whole
 * chain at once. The table is a few hundred rows, so this costs nothing.
 *
 * Walking only from roots (rows that replaced nothing) means a cycle, which no real
 * reschedule can form, is never reached: its rows resolve to NULL and read as their
 * own booked_on rather than hanging the query. A root with no booked_on resolves its
 * chain to NULL the same way, so a replacement is never dated from a blank. The
 * path check is belt and braces for the cycle.
 */
async function resolveOrigins(pool) {
  await pool.query(`
    WITH RECURSIVE chain AS (
      SELECT id, booked_on AS origin, ARRAY[id] AS path
        FROM bookings WHERE rescheduled_from IS NULL
      UNION ALL
      SELECT b.id, c.origin, c.path || b.id
        FROM bookings b JOIN chain c ON b.rescheduled_from = c.id
       WHERE NOT b.id = ANY(c.path)
    ),
    resolved AS (
      SELECT b.id, CASE WHEN b.rescheduled_from IS NULL THEN NULL ELSE c.origin END AS origin
        FROM bookings b LEFT JOIN chain c ON c.id = b.id
    )
    UPDATE bookings b SET originated_on = r.origin
      FROM resolved r
     WHERE b.id = r.id AND b.originated_on IS DISTINCT FROM r.origin`);
}

// ─────────────────────────────────────────────────────────────
// Revenue comes from FINANCIAL RECORDS, not from opportunities. Do not change this
// back without reading the rest of this comment.
//
// Every sale creates a contract and a financial record against the same
// opportunity. Qualifying revenue by the OPPORTUNITY's stage assumes those three
// always agree, and they do not: Central Wesleyan had two opportunities and its
// contract sat on the closed-lost one, so its revenue vanished from every total
// that filtered on a won stage. Federal Credit Union was mis-staged the same way.
// That is roughly $200k of real, signed business that the dashboard denied while
// Salesforce reported it — and nothing surfaced the disagreement, which is why it
// took a meeting months later to notice.
//
// A financial record is never "lost". It exists because a contract was signed. So
// inclusion is decided by the financial record itself, and the opportunity is kept
// only to CHECK the data, never to qualify it. There is deliberately no
// opportunity_stage or opportunity_is_won condition below, and adding one would
// reintroduce the exact bug.
//
// These four conditions mirror the Salesforce report "All Sec Financials Only",
// which is the number leadership works from ($1,838,000 over 98 records at the time
// of writing). Each is stated separately so the data-quality panel can report what
// every one of them removed, rather than a record simply going missing:
//
//   purpose        the report filters Purpose for Creating Financial = New Contract
//                  Signed. Renewals and amendments create financials too, and they
//                  are not new business.
//   non_security   Brad's flag for work outside the security grant business. Stored
//                  as a real boolean, so a record whose box was never touched reads
//                  false and still counts as security work.
//   opportunity    the report is built on "Financials with Opportunity", so a
//                  financial with no opportunity is already outside its total. It is
//                  still stored, still counted by the quality panel, and still shown
//                  — excluded, not invisible.
//   created_date   the report starts at 1 Nov 2024. Earlier records predate the
//                  security grant business.
const FINANCIAL_PURPOSE = process.env.SF_FINANCIAL_PURPOSE || 'New Contract Signed';
const FINANCIALS_SINCE = process.env.SF_FINANCIALS_SINCE || '2024-11-01';
const COUNTABLE_FINANCIAL = `
      purpose = $1
  AND non_security IS NOT TRUE
  AND opportunity_id IS NOT NULL
  AND created_date >= $2::timestamptz`;
const FINANCIAL_ARGS = [FINANCIAL_PURPOSE, FINANCIALS_SINCE];

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
      // Stale-only refresh: normally a small set, run synchronously so a UI reload
      // sees fresh data.
      const { rows } = await pool.query(
        // The third condition is a backfill that retires itself. Grouping moved onto
        // the campaign id, but every booking enriched before that column existed has
        // a name and no id, so it still groups by name -- which is the split this was
        // meant to end. Those rows are enriched and resolved, so neither of the first
        // two conditions reaches them and neither does the periodic sweep, which only
        // looks a week back. They would have sat there for good.
        //
        // Re-enriching resolves the id from the name it already holds, after which the
        // row stops matching. No migration, and nothing to remember to run once. It is
        // a rename, not a re-attribution: sticky attribution means the campaign itself
        // cannot move here, so this backfill can no longer smuggle one in.
        `SELECT id FROM bookings
          WHERE enriched_at IS NULL
             OR (meeting_date < NOW() AND held IS NULL)
             OR ${NEEDS_CAMPAIGN_ID}`
      );
      // Except when it is not small. Every unresolved booking now also costs a
      // lookup to identify it, so a backlog that used to finish inside the request
      // can outlast it — and a refresh that times out looks like a refresh that
      // failed, which is the one outcome worth avoiding.
      if (rows.length > 25) {
        // Saying only "in progress" made a refresh that queried nothing look like a
        // refresh that worked. The count is what distinguishes them.
        if (_enrichRunning) return res.json({ ok: true, running: true, pending: rows.length,
          message: `${rows.length} still to refresh — another sweep holds the lock, they will be picked up` });
        _enrichRunning = true;
        res.json({ ok: true, started: rows.length, message: 'running in the background — reload shortly' });
        (async () => {
          for (const r of rows) { try { await enrichBooking(pool, r.id); } catch (e) { console.error('enrich error:', e.message); } }
          console.log(`[marketing] stale refresh complete: ${rows.length} rows`);
        })().catch(e => console.error('stale refresh error:', e.message)).finally(() => { _enrichRunning = false; });
        return;
      }
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
          COUNT(*) FILTER (WHERE ${MONTH_OF_BOOKING} = ${THIS_MONTH})::int AS bookings_this_month,
          COUNT(*) FILTER (WHERE ${MONTH_OF_BOOKING} = ${THIS_MONTH} - interval '1 month')::int AS bookings_last_month,
          -- Sunday 00:00 → Saturday 23:59, Central
          COUNT(*) FILTER (WHERE ${WEEK_OF_BOOKING} = ${THIS_WEEK})::int AS bookings_this_week,
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
        SELECT exclusion_reason AS reason,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE ${WEEK_OF_BOOKING} = ${THIS_WEEK})::int AS this_week
          FROM bookings WHERE exclusion_reason IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`);

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

      // The revenue layer proper. See COUNTABLE_FINANCIAL above for why this is
      // sourced from financial records rather than from won opportunities.
      const { rows: [fin] } = await pool.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(amount),0)::numeric AS revenue,
               COUNT(*) FILTER (WHERE booking_id IS NOT NULL)::int AS attr_count,
               COALESCE(SUM(amount) FILTER (WHERE booking_id IS NOT NULL),0)::numeric AS attr_revenue,
               COUNT(*) FILTER (WHERE booking_id IS NULL)::int AS untracked_count,
               COALESCE(SUM(amount) FILTER (WHERE booking_id IS NULL),0)::numeric AS untracked_revenue,
               COUNT(DISTINCT COALESCE(NULLIF(regexp_replace(lower(organization), '[^a-z0-9]', '', 'g'),''),
                                       financial_id))::int AS org_count
          FROM sf_financials WHERE ${COUNTABLE_FINANCIAL}`, FINANCIAL_ARGS);

      // Until the financials sync has delivered anything, the opportunity figures
      // still answer — the same fallback the Salesforce layer already used before
      // it was populated. The moment financials arrive the headline moves to them,
      // and the quality panel shows both totals side by side either way.
      const hasFin = fin.count > 0;
      const layer = hasFin
        ? { count: fin.count, revenue: Number(fin.revenue), org_count: fin.org_count,
            attr_count: fin.attr_count, attr_revenue: Number(fin.attr_revenue),
            untracked_count: fin.untracked_count, untracked_revenue: Number(fin.untracked_revenue) }
        : { count: sw.sf_count, revenue: Number(sw.sf_revenue), org_count: sw.sf_org_count,
            attr_count: sw.sf_attr_count, attr_revenue: Number(sw.sf_attr_revenue),
            untracked_count: sw.sf_untracked_count, untracked_revenue: Number(sw.sf_untracked_revenue) };
      const hasSf = layer.count > 0;
      const sfTotalRev = layer.revenue;

      // A financial whose Purpose was never set is excluded from every figure above,
      // and that is nearly always the field not being filled in rather than a
      // deliberate classification. Peninsula Covenant and Vintage Faith both sat
      // outside the total this way -- $24,000 between them -- while the Salesforce
      // report, which does not filter on Purpose, showed them. Two numbers that are
      // supposed to agree quietly stopped agreeing, and nothing said so.
      //
      // Only a BLANK purpose is reported. A record deliberately marked as something
      // else ("Adding Legacy Contract and Financial", 111 of them) is meant to be
      // outside the total; warning about those would make this a permanent line that
      // nobody reads, which is the same as not having it.
      const { rows: [unset] } = await pool.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(amount),0)::numeric AS amount
          FROM sf_financials
         WHERE NULLIF(btrim(purpose), '') IS NULL
           AND non_security IS NOT TRUE
           AND opportunity_id IS NOT NULL
           AND created_date >= $1::timestamptz`, [FINANCIALS_SINCE]);

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
        won_count_total: layer.count,
        won_org_count: layer.org_count,
        attributed_revenue: layer.attr_revenue,
        attributed_count: layer.attr_count,
        untracked_revenue: layer.untracked_revenue,
        untracked_count: layer.untracked_count,
        attribution_coverage: sfTotalRev > 0 ? layer.attr_revenue / sfTotalRev : 0,
        // Which store the headline came from, so the UI never has to guess.
        revenue_source: hasFin ? 'financials' : 'opportunities',
        // Excluded from every figure above, broken out by reason so the dashboard can
        // say what it left out and why.
        excluded: exrows.map(r => ({
          reason: r.reason,
          label: EXCLUSION_LABELS[r.reason] || r.reason,
          total: r.total,
          this_week: r.this_week,
        })),
        excluded_total: exrows.reduce((a, r) => a + r.total, 0),
        excluded_this_week: exrows.reduce((a, r) => a + r.this_week, 0),
        // Signed business the revenue figures are leaving out because nobody set the
        // Purpose on its financial record. Zero whenever the data is clean, which is
        // the point of reporting it this way: silent until it has something to say.
        revenue_unset_purpose: { count: unset.count, amount: Number(unset.amount) },
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
               COUNT(*) FILTER (WHERE held IS NOT NULL)::int AS resolved,
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
      // Grouped on the campaign ID, not its name. Names drift: renaming a campaign
      // in Instantly used to strand every earlier booking under the old name, and
      // three dead names were holding 63 bookings between them when this was found.
      //
      // The fold happens here rather than in SQL so a row that has an id and a row
      // that only has a name can still land together. Rows enriched before the id
      // column existed have no id, so keying on the id in SQL would have split every
      // campaign in two for as long as the backfill took to catch up -- worse
      // before better, on the exact table this is meant to fix.
      const map = await instantlyCampaignMap();
      const { rows } = await pool.query(`
        SELECT instantly_campaign_id AS cid,
               instantly_campaign     AS cname,
               CASE
                 WHEN attribution_channel = 'instantly'   THEN 'Instantly – campaign unknown'
                 WHEN attribution_channel = 'google_ads'  THEN 'Google Ads'
                 WHEN attribution_channel = 'search'      THEN 'Organic Search'
                 WHEN attribution_channel = 'email'       THEN 'Email'
                 WHEN attribution_channel = 'social'      THEN 'Social'
                 WHEN attribution_channel = 'linkedin'    THEN 'LinkedIn'
                 WHEN attribution_channel = 'referral'    THEN 'Referral'
                 WHEN attribution_channel = 'conference'  THEN 'Conference'
                 WHEN attribution_channel = 'past_engaged_prospect' THEN 'Past Engaged Prospect'
                 WHEN COALESCE(NULLIF(attribution_channel,''),'direct') = 'direct' THEN 'Direct / Other'
                 ELSE initcap(attribution_channel)
               END AS channel_label,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
          FROM bookings WHERE ${COUNTABLE}
         GROUP BY 1, 2, 3`);

      const out = new Map();
      for (const r of rows) {
        const isCampaign = Boolean(r.cid || r.cname);
        // Instantly's current name wins over whatever was stored when the booking
        // was enriched; the stored name is the fallback for a campaign the
        // workspace no longer returns (archived, or deleted outright).
        //
        // A row with no id falls back to a dead name before it falls back to the
        // stored one, so a rename folds here immediately rather than waiting on the
        // backfill -- which matters because the display is the whole symptom: three
        // renamed campaigns were each showing as a separate one-booking row.
        const cid = r.cid || deadNameToId(r.cname);
        const label = isCampaign
          ? ((cid && map[cid]) || r.cname || 'Instantly – campaign unknown')
          : r.channel_label;
        const key = `${isCampaign ? 'c' : 'x'}:${label}`;
        const cur = out.get(key) || { campaign: label, is_campaign: isCampaign,
                                      booked: 0, held: 0, clients: 0, fees: 0 };
        cur.booked += r.booked; cur.held += r.held;
        cur.clients += r.clients; cur.fees += Number(r.fees);
        out.set(key, cur);
      }
      res.json([...out.values()].sort((a, b) => b.booked - a.booked));
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
    // The same Sunday-to-Saturday Central weeks as the "bookings this week" tile.
    // They once disagreed (the chart used Monday weeks), and a Sunday booking sat in
    // the tile's current week and the chart's previous bar at the same time.
    const bucket = g === 'week' ? WEEK_OF_BOOKING : MONTH_OF_BOOKING;
    const step = g === 'week' ? '1 week' : '1 month';
    try {
      const { rows } = await pool.query(`
        WITH b AS (
          SELECT ${bucket} AS period,
                 held, became_client, won, won_amount
            FROM bookings WHERE ${ORIGINATED} IS NOT NULL AND ${COUNTABLE}
        ),
        bounds AS (SELECT MIN(period) AS lo, MAX(period) AS hi FROM b),
        -- A week with no bookings has to read as a gap, not close up and make the
        -- run of weeks look continuous. sales-timeseries has done this since it was
        -- written; this chart is the one that quietly dropped empty periods.
        periods AS (
          SELECT generate_series(lo, hi, INTERVAL '${step}') AS period FROM bounds
        )
        SELECT to_char(p.period, 'YYYY-MM-DD') AS period,
               COUNT(b.period)::int AS booked,
               COUNT(*) FILTER (WHERE b.held IS TRUE)::int AS held,
               -- Meetings whose outcome is actually known. A meeting still in the
               -- future has held IS NULL, and counting it as "booked but not held"
               -- makes a held RATE drift upward on its own as dates pass.
               COUNT(*) FILTER (WHERE b.held IS NOT NULL)::int AS resolved,
               COUNT(*) FILTER (WHERE b.became_client)::int AS clients,
               COUNT(*) FILTER (WHERE b.won)::int AS won,
               COALESCE(SUM(b.won_amount) FILTER (WHERE b.won),0)::numeric AS won_amount
          FROM periods p
          LEFT JOIN b ON b.period = p.period
         GROUP BY p.period ORDER BY p.period`);
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
      // Same source as the headline, or the chart tells a different story from the
      // number above it. Financials are dated by when the record was created, which
      // is what the Salesforce report groups on.
      const { rows: [{ n }] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM sf_financials WHERE ${COUNTABLE_FINANCIAL}`, FINANCIAL_ARGS);
      const fromFinancials = n > 0;
      const source = fromFinancials
        ? `SELECT COALESCE(NULLIF(regexp_replace(lower(organization), '[^a-z0-9]', '', 'g'), ''), financial_id) AS org_key,
                  date_trunc('${g}', ${central('created_date')}) AS period, amount
             FROM sf_financials
            WHERE created_date IS NOT NULL AND ${COUNTABLE_FINANCIAL}`
        : `SELECT COALESCE(NULLIF(regexp_replace(lower(organization), '[^a-z0-9]', '', 'g'), ''), opportunity_id) AS org_key,
                  -- close_date is a date-only Salesforce field stored as UTC
                  -- midnight, so it stays as it is: converting it to Central
                  -- would slide the 1st of every month into the month before.
                  date_trunc('${g}', close_date) AS period, amount
             FROM sf_wins
            WHERE close_date IS NOT NULL`;
      const { rows } = await pool.query(`
        WITH w AS (${source}),
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
         ORDER BY p.period`, fromFinancials ? FINANCIAL_ARGS : []);
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
        // The two joins carry the dates either side of a reschedule, so the list can
        // say what a moved meeting moved from or to without a second round trip.
        `SELECT b.id, b.booked_on, b.originated_on, b.meeting_date, b.name, b.organization, b.email, b.told_us,
                b.attribution_channel, b.attribution_source, b.instantly_campaign,
                -- The id as well as the name. The toolbox builds its own campaign
                -- table in the browser, because that panel is range-scoped and
                -- by-campaign is not, and it had only the name to group on -- so a
                -- campaign renamed in Instantly split into two rows there even after
                -- #158 and #173 fixed exactly that on this side. Grouping needs the
                -- id, and the id is not something the client can derive.
                b.instantly_campaign_id, b.host,
                b.held, b.became_client, b.fee,
                b.won, b.won_amount, b.exclusion_reason, b.cancelled, b.cancelled_at,
                b.rescheduled_from, b.rescheduled_to,
                prev.meeting_date AS rescheduled_from_date,
                next.meeting_date AS rescheduled_to_date
         FROM bookings b
         LEFT JOIN bookings prev ON prev.id = b.rescheduled_from
         LEFT JOIN bookings next ON next.id = b.rescheduled_to
         WHERE ($1='' OR b.name ILIKE '%'||$1||'%' OR b.organization ILIKE '%'||$1||'%' OR b.email ILIKE '%'||$1||'%')
           AND ($2='' OR b.attribution_channel=$2)
           AND ($3='' OR b.instantly_campaign=$3)
         ORDER BY b.booked_on DESC NULLS LAST LIMIT 500`,
        [search, channel, campaign]
      );
      res.json(rows.map(r => ({ ...r, fee: Number(r.fee), won_amount: Number(r.won_amount) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Where the two revenue stories disagree.
  //
  // The $200k gap was found in a meeting, months after it opened, because nothing
  // ever compared the two totals. This puts the comparison on the dashboard and
  // names the records behind it. Every flag here is a real failure that already
  // happened, or the direct neighbour of one.
  app.get('/api/marketing/revenue-quality', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const q = (sql, args = FINANCIAL_ARGS) => pool.query(sql, args).then(r => r.rows);

      const [totals] = await q(`
        SELECT
          (SELECT COALESCE(SUM(amount),0)::numeric FROM sf_financials WHERE ${COUNTABLE_FINANCIAL}) AS financial_total,
          (SELECT COUNT(*)::int         FROM sf_financials WHERE ${COUNTABLE_FINANCIAL}) AS financial_count,
          (SELECT COALESCE(SUM(amount),0)::numeric FROM sf_wins) AS opportunity_total,
          (SELECT COUNT(*)::int         FROM sf_wins)            AS opportunity_count`);

      // What each filter removed, stated rather than implied. A record that does not
      // count should be visible as excluded; silence is what let the gap survive.
      const [excluded] = await q(`
        SELECT
          COUNT(*) FILTER (WHERE purpose IS DISTINCT FROM $1)::int AS other_purpose,
          COALESCE(SUM(amount) FILTER (WHERE purpose IS DISTINCT FROM $1),0)::numeric AS other_purpose_amount,
          COUNT(*) FILTER (WHERE non_security IS TRUE)::int AS non_security,
          COALESCE(SUM(amount) FILTER (WHERE non_security IS TRUE),0)::numeric AS non_security_amount,
          COUNT(*) FILTER (WHERE created_date < $2::timestamptz)::int AS before_start,
          COALESCE(SUM(amount) FILTER (WHERE created_date < $2::timestamptz),0)::numeric AS before_start_amount
        FROM sf_financials`);

      // 1. The Central Wesleyan failure itself: money earned, sitting on a lost
      //    opportunity. Counted here, and deliberately still counted in the total.
      const closedLost = await q(`
        SELECT financial_id, name, organization, amount, contract_number,
               opportunity_id, opportunity_name, opportunity_stage
          FROM sf_financials
         WHERE ${COUNTABLE_FINANCIAL}
           AND (opportunity_is_won IS FALSE OR opportunity_stage ILIKE '%lost%')
         ORDER BY amount DESC`);

      // 2. No opportunity to check against, or one belonging to a different account.
      const orphaned = await q(`
        SELECT financial_id, name, organization, amount, contract_number,
               account_id, opportunity_id, opportunity_account_id,
               CASE WHEN opportunity_id IS NULL THEN 'no linked opportunity'
                    ELSE 'opportunity belongs to another account' END AS problem
          FROM sf_financials
         WHERE purpose = $1
           AND non_security IS NOT TRUE
           AND created_date >= $2::timestamptz
           AND ( opportunity_id IS NULL
              OR (account_id IS NOT NULL AND opportunity_account_id IS NOT NULL
                  AND account_id <> opportunity_account_id) )
         ORDER BY amount DESC`);

      // 3. One account's financials spread over several opportunities — the shape
      //    that produced the original mis-link, whether or not it has cost anything
      //    yet. Worth seeing before it does.
      const split = await q(`
        SELECT organization,
               COUNT(DISTINCT opportunity_id)::int AS opportunities,
               COUNT(*)::int AS financials,
               COALESCE(SUM(amount),0)::numeric AS amount,
               ARRAY_AGG(DISTINCT COALESCE(opportunity_stage,'(no stage)')) AS stages
          FROM sf_financials
         WHERE ${COUNTABLE_FINANCIAL} AND organization IS NOT NULL
         GROUP BY organization
        HAVING COUNT(DISTINCT opportunity_id) > 1
         ORDER BY amount DESC`);

      const financialTotal = Number(totals.financial_total);
      const opportunityTotal = Number(totals.opportunity_total);
      const num = (rows, ...keys) => rows.map(r => {
        for (const k of keys) r[k] = Number(r[k]);
        return r;
      });

      res.json({
        source: totals.financial_count > 0 ? 'financials' : 'opportunities',
        financial_total: financialTotal,
        financial_count: totals.financial_count,
        opportunity_total: opportunityTotal,
        opportunity_count: totals.opportunity_count,
        // Positive means the opportunity-based view is under-reporting, which is the
        // direction the original bug ran in.
        delta: financialTotal - opportunityTotal,
        filters: {
          purpose: FINANCIAL_PURPOSE,
          since: FINANCIALS_SINCE,
          excludes_non_security: true,
          excludes_missing_opportunity: true,
          filters_on_opportunity_stage: false,
        },
        excluded: {
          other_purpose: { count: excluded.other_purpose, amount: Number(excluded.other_purpose_amount) },
          non_security: { count: excluded.non_security, amount: Number(excluded.non_security_amount) },
          before_start: { count: excluded.before_start, amount: Number(excluded.before_start_amount) },
        },
        flags: {
          closed_lost_opportunity: num(closedLost, 'amount'),
          orphaned_or_mismatched: num(orphaned, 'amount'),
          split_across_opportunities: num(split, 'amount'),
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Why a booking cannot answer for itself.
  //
  // Held, cancelled and the reschedule link all come from one place: asking Calendly
  // about the row's event. A row with no event_uri can never be asked, so it sits at
  // held IS NULL for ever and no amount of re-running enrichment changes it — and
  // nothing on the dashboard says so, because a booking with an unknown outcome and
  // one with a genuinely empty checkbox look identical.
  //
  // This states the shape of that problem rather than leaving it to be inferred from
  // a rate that looks too clean. It also probes the Calendly token live, since every
  // derived field on this table is downstream of it.
  app.get('/api/marketing/bookings/diagnostics', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows: [counts] } = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE event_uri IS NOT NULL)::int AS with_event_uri,
               COUNT(*) FILTER (WHERE calendly_uri IS NOT NULL)::int AS with_calendly_uri,
               COUNT(*) FILTER (WHERE rescheduled_from IS NOT NULL)::int AS linked_reschedules,
               COUNT(*) FILTER (WHERE meeting_date < NOW())::int AS past_meetings,
               COUNT(*) FILTER (WHERE meeting_date < NOW() AND held IS TRUE)::int AS past_held,
               COUNT(*) FILTER (WHERE meeting_date < NOW() AND held IS FALSE)::int AS past_no_show,
               COUNT(*) FILTER (WHERE meeting_date < NOW() AND held IS NULL)::int AS past_unresolved,
               COUNT(*) FILTER (WHERE meeting_date < NOW() AND held IS NULL
                                  AND event_uri IS NULL)::int AS past_unresolved_no_event_uri,
               COUNT(*) FILTER (WHERE held_source = 'calendly')::int AS held_from_calendly,
               COUNT(*) FILTER (WHERE held_source = 'manual')::int AS held_set_by_hand,
               COUNT(*) FILTER (WHERE enriched_at IS NULL)::int AS never_enriched,
               MAX(enriched_at) AS last_enriched
          FROM bookings`);

      // A token that has stopped working looks exactly like a table full of meetings
      // nobody has got round to marking, so it is worth answering directly.
      const token = process.env.CALENDLY_API_TOKEN;
      const calendly = { token_configured: Boolean(token), reachable: null };
      if (token) {
        try {
          const r = await fetch(`${CAL_API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
          calendly.reachable = r.ok;
          calendly.status = r.status;
        } catch (e) {
          calendly.reachable = false;
          calendly.error = e.message;
        }
      }

      const { rows: unresolved } = await pool.query(`
        SELECT id, organization, name, meeting_date, enriched_at,
               (event_uri IS NOT NULL) AS has_event_uri,
               (calendly_uri IS NOT NULL) AS has_calendly_uri
          FROM bookings
         WHERE meeting_date < NOW() AND held IS NULL AND exclusion_reason IS NULL
         ORDER BY meeting_date DESC LIMIT 20`);

      res.json({ ...counts, calendly, unresolved_sample: unresolved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Import a Calendly event type's history. Runs in the background because ~100
  // meetings means ~200 Calendly calls, well past any sensible request timeout, and
  // records the outcome in sync_runs so the result survives the request that started
  // it. dry_run=1 reads Calendly and reports what it found without writing anything —
  // worth using first, since the last hand-run backfill on this project put a
  // cancelled deal back on the dashboard.
  app.post('/api/marketing/bookings/backfill-calendly', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const eventType = req.body?.event_type;
    const since = req.body?.since || null;
    const dryRun = req.body?.dry_run === true || req.query.dry_run === '1';
    if (!eventType) return res.status(400).json({ error: 'event_type (Calendly event type URI or UUID) required' });
    const uri = eventType.startsWith('http') ? eventType : `${CAL_API}/event_types/${eventType}`;

    // A dry run is quick enough to answer inline, and answering inline is the point.
    if (dryRun) {
      try {
        return res.json({ ok: true, dry_run: true, ...(await backfillCalendly(pool, { eventType: uri, since, dryRun: true })) });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    res.json({ ok: true, started: true, message: 'running in the background — check /api/marketing/sync/status' });
    (async () => {
      const { rows: [run] } = await pool.query(
        `INSERT INTO sync_runs (source) VALUES ('calendly_backfill') RETURNING id`);
      try {
        const r = await backfillCalendly(pool, { eventType: uri, since, dryRun: false });
        await pool.query(
          `UPDATE sync_runs SET finished_at=NOW(), ok=TRUE, rows_seen=$2, note=$3 WHERE id=$1`,
          [run.id, r.ingested, `scanned ${r.scanned}, skipped ${r.skipped}, failed ${r.failed}`]);
        console.log(`[calendly-backfill] done — ${r.ingested} of ${r.scanned} ingested`);
      } catch (err) {
        await pool.query(`UPDATE sync_runs SET finished_at=NOW(), ok=FALSE, error=$2 WHERE id=$1`, [run.id, err.message]);
        console.error('[calendly-backfill] failed:', err.message);
      }
    })().catch(e => console.error('[calendly-backfill] unhandled:', e.message));
  });

  // Manual override toggles (Held / Won / Unqualified).
  // What somebody needs in order to name the campaign themselves: the campaigns that
  // could account for this booking with the evidence for each, and the full list to
  // fall back on when none of them fit.
  //
  // Asked per booking, when the picker opens, rather than for the whole table — each
  // answer costs several Instantly searches, and almost every row already knows its
  // campaign and will never be asked.
  app.get('/api/marketing/bookings/:id/campaign-options', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(
        `SELECT id, email, name, organization, instantly_campaign, attribution_source
           FROM bookings WHERE id = $1`, [req.params.id]);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: 'not found' });

      const map = await instantlyCampaignMap();
      const all = [...new Set(Object.values(map).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      const { suggestions, unnamed_campaign_ids } = await instantlyCampaignCandidates(row);

      res.json({
        current: row.instantly_campaign || null,
        source: row.attribution_source || null,
        suggestions,
        all,
        // Both of these explain an empty suggestion list, which otherwise looks the
        // same whether Instantly has nothing or this app cannot ask it anything.
        unnamed_campaign_ids,
        configured: Boolean(process.env.INSTANTLY_API_KEY),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // These live in manual_override, which nothing outside this tool reads or writes:
  // marking a booking here never touches Calendly, Instantly or Salesforce, and a
  // re-sync from any of them cannot undo it.
  app.patch('/api/marketing/bookings/:id', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { held, became_client, exclusion, channel, campaign } = req.body || {};
      // '' clears the reason and puts the booking back in the totals; anything not on
      // the list is ignored rather than stored, so a typo cannot invent a new reason.
      if (exclusion !== undefined && exclusion !== '' && !EXCLUSION_REASONS.includes(exclusion)) {
        return res.status(400).json({ error: `exclusion must be one of: ${EXCLUSION_REASONS.join(', ')}` });
      }
      const cur = await pool.query('SELECT manual_override FROM bookings WHERE id=$1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const ov = { ...(cur.rows[0].manual_override || {}) };
      if (typeof channel === 'string') {
        if (channel === '') delete ov.channel; else ov.channel = channel;
      }
      // '' hands the booking back to automatic detection, same as channel. Naming a
      // campaign also clears any channel override, because the campaign implies the
      // channel and leaving a stale one behind would only fight it on the next pass.
      if (typeof campaign === 'string') {
        if (campaign === '') delete ov.campaign;
        else { ov.campaign = campaign; delete ov.channel; }
      }
      if (typeof held === 'boolean') ov.held = held;
      if (typeof became_client === 'boolean') ov.became_client = became_client;
      if (exclusion !== undefined) {
        if (exclusion === '') delete ov.exclusion; else ov.exclusion = exclusion;
      }
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
      // Two changes of shape from "recent events only". A row with no event_uri was
      // skipped entirely, which is exactly backwards: those are the rows that need
      // identifying before they can be asked anything. And a past meeting with no
      // recorded outcome is worth another look however old it is, since until now
      // nothing ever came back for it — bounded because resolving it, or setting it
      // aside, drops it straight out of this set.
      const { rows } = await pool.query(
        `SELECT id FROM bookings
          WHERE ((event_uri IS NOT NULL OR (email IS NOT NULL AND meeting_date IS NOT NULL))
                 AND (meeting_date IS NULL
                      OR meeting_date > NOW() - interval '7 days'
                      OR (held IS NULL AND exclusion_reason IS NULL)))
             OR ${NEEDS_CAMPAIGN_ID}`);
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
