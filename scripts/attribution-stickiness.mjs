// Proves campaign attribution is sticky: a reverse lookup fills a gap, it never
// revises an answer. Drives the REAL /api/marketing/enrich handler against a
// throwaway Postgres, so it exercises the sweep exactly as production does.
//
// The point of the fixture is the one detail that made this so hard to see: when a
// lead is moved between Instantly campaigns, Instantly MOVES rather than copies, so
// timestamp_created still holds the ORIGINAL import date. Case A does exactly that
// and then re-enriches. Against the code before this script was added, A2, E and E2
// all fail -- which is the corruption, reproduced.
//
//   initdb -D /tmp/pgc/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
//   node scripts/attribution-stickiness.mjs
//
// PGHOST overrides the socket directory; TARGET points at an alternate copy of
// marketing.js, which is how the before/after comparison is run.
import pg from 'pg';

const P1  = 'a2a95058-21b8-41c4-8c39-a340976e66d3'; // Broader Church Campaign - Phase 1
const XP  = '26dde45b-476d-4571-a3e5-652d006aeb82'; // XP Campaign 11.5.2025
const REM = '8552c05f-c927-48ee-b654-66f33e1c5cf1'; // Remarket FY27 - Non-Repliers
const NAMES = {
  [P1]:  'Broader Church Campaign - Phase 1',
  [XP]:  'XP Campaign 11.5.2025',
  [REM]: 'Remarket FY27 - Non-Repliers',
};

// Where each lead currently lives. Mutating this is what "Stuart moved the lead"
// means: Instantly MOVES rather than copies, so timestamp_created never changes.
const LEADS = {
  'alex@vivallgroup.com': { campaign: XP, timestamp_created: '2025-11-05T00:00:00Z' },
  'gap@newprospect.org':  { campaign: P1, timestamp_created: '2026-01-10T00:00:00Z' },
};

const realFetch = globalThis.fetch;           // captured FIRST, before stubbing
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('api.instantly.ai')) return realFetch(url, init);
  const json = (o) => new Response(JSON.stringify(o), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  if (u.includes('/campaigns')) {
    return json({ items: Object.entries(NAMES).map(([id, name]) => ({ id, name })) });
  }
  if (u.includes('/leads/list')) {
    const body = JSON.parse(init.body || '{}');
    const term = String(body.search || '').toLowerCase();
    const items = Object.entries(LEADS)
      .filter(([email]) => email.includes(term) || term.includes(email.split('@')[1] || ' '))
      .map(([email, l]) => ({
        email, campaign: l.campaign, timestamp_created: l.timestamp_created,
        first_name: 'Alex', last_name: 'Doe', company_name: 'Vivall Group',
      }));
    return json({ items });
  }
  return json({ items: [] });
};

process.env.INSTANTLY_API_KEY = 'test-key';
delete process.env.CALENDLY_API_TOKEN;        // enrich must survive with no Calendly
process.env.BOOKING_SWEEP_MINUTES = '100000'; // never let the background sweep race us

const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST || '/tmp/pgc/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

// Capture the real route handlers off a stubbed app, per the house method.
const routes = {};
const app = {
  get:   (p, h) => { routes[`GET ${p}`]   = h; },
  post:  (p, h) => { routes[`POST ${p}`]  = h; },
  put:   (p, h) => { routes[`PUT ${p}`]   = h; },
  patch: (p, h) => { routes[`PATCH ${p}`] = h; },
  use:   () => {},
};

const { registerMarketing } = await import(process.env.TARGET || '../server/marketing.js');
registerMarketing(app, pool);
await new Promise(r => setTimeout(r, 800));   // let ensureSchema finish

// enrichBooking joins letters -- without this table every enrich fails silently.
await pool.query(`CREATE TABLE IF NOT EXISTS letters (
  id SERIAL PRIMARY KEY, client_name TEXT, doc_tab TEXT,
  total_fee NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

const call = (key, req = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  Promise.resolve(routes[key]({ query: {}, body: {}, params: {}, headers: {}, ...req }, res))
    .catch(reject);
});

// ?all=1 answers immediately and sweeps in the background; wait for the write.
async function enrichAll() {
  const before = (await pool.query(
    'SELECT COALESCE(MAX(updated_at), NOW()) m FROM bookings')).rows[0].m;
  await call('POST /api/marketing/enrich', { query: { all: '1' } });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 100));
    const { rows } = await pool.query(
      `SELECT MAX(updated_at) m, COUNT(*) FILTER (WHERE enriched_at IS NULL) pending FROM bookings`);
    if (rows[0].pending === '0' && rows[0].m > before) return;
  }
  throw new Error('enrich sweep did not finish');
}

const get = async (id) => (await pool.query(
  `SELECT instantly_campaign c, instantly_campaign_id cid,
          attribution_source src, attribution_lead_at lat
     FROM bookings WHERE id=$1`, [id])).rows[0];

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push({ name, ok, got, want });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

await pool.query('TRUNCATE bookings RESTART IDENTITY');

// A. the corruption itself: an attributed booking whose lead is later MOVED
const a = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, organization, booked_on, meeting_date)
   VALUES ('cal/a','alex@vivallgroup.com','Alex Doe','Vivall Group','2025-12-01','2025-12-05')
   RETURNING id`)).rows[0].id;
await enrichAll();
check('A1 first enrich attributes to the lead campaign (XP)', (await get(a)).cid, XP);

LEADS['alex@vivallgroup.com'].campaign = REM;   // Stuart bulk-moves the lead. Date unchanged.
await enrichAll();
check('A2 re-enrich after the lead MOVED keeps the original campaign', (await get(a)).cid, XP);
check('A2b and keeps the original source', (await get(a)).src, 'reverse_email');

// B. a gap is still filled
const b = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, organization, booked_on, meeting_date)
   VALUES ('cal/b','gap@newprospect.org','Sam Gap','New Prospect','2026-02-01','2026-02-05')
   RETURNING id`)).rows[0].id;
await enrichAll();
check('B  a booking with no campaign is still attributed', (await get(b)).cid, P1);

// C. a UTM tag still overrules an existing campaign
const c = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, booked_on, meeting_date, utm_source, utm_campaign,
                         instantly_campaign, instantly_campaign_id, attribution_source, enriched_at)
   VALUES ('cal/c','utm@x.org','U Tag','2026-03-01','2026-03-05','instantly','remarket-fy27',
           $1, $2, 'reverse_domain', NOW()) RETURNING id`, [NAMES[P1], P1])).rows[0].id;
await enrichAll();
check('C  a UTM tag still overrules what is recorded', (await get(c)).cid, REM);

// D. a human override still wins
const d = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, booked_on, meeting_date, instantly_campaign,
                         instantly_campaign_id, attribution_source, manual_override, enriched_at)
   VALUES ('cal/d','manual@x.org','M Anual','2026-03-01','2026-03-05', $1, $2, 'reverse_email',
           $3::jsonb, NOW()) RETURNING id`,
  [NAMES[P1], P1, JSON.stringify({ campaign: NAMES[REM] })])).rows[0].id;
await enrichAll();
check('D  a human override still wins', (await get(d)).cid, REM);

// E. name-to-id backfill still converges, without moving the campaign
const e = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, booked_on, meeting_date, instantly_campaign,
                         instantly_campaign_id, attribution_source, enriched_at)
   VALUES ('cal/e','alex@vivallgroup.com','Alex Doe','2026-03-01','2026-03-05', $1, NULL,
           'reverse_email', NOW()) RETURNING id`, [NAMES[P1]])).rows[0].id;
await enrichAll();
check('E  a name with no id resolves its id', (await get(e)).cid, P1);
check('E2 without the campaign name moving', (await get(e)).c, NAMES[P1]);

// F. a lead Instantly gave no date for stores '-infinity', not null. The sticky path
// carries that value straight back out through node-pg, and blanking it would put the
// row back in a re-enrich set for ever. Pinned because the round-trip is not obvious:
// node-pg reads '-infinity' as the JS number -Infinity and writes it back correctly.
const f = (await pool.query(
  `INSERT INTO bookings (calendly_uri, email, name, booked_on, meeting_date, instantly_campaign,
                         instantly_campaign_id, attribution_source, attribution_lead_at, enriched_at)
   VALUES ('cal/f','alex@vivallgroup.com','Alex Doe','2026-03-01','2026-03-05', $1, $2,
           'reverse_email', '-infinity', NOW()) RETURNING id`, [NAMES[XP], XP])).rows[0].id;
await enrichAll();
check('F  an undated lead keeps its campaign', (await get(f)).cid, XP);
check('F2 and its -infinity marker survives the round-trip',
  (await pool.query(`SELECT attribution_lead_at::text t FROM bookings WHERE id=$1`, [f])).rows[0].t,
  '-infinity');

await pool.end();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
