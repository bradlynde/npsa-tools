// Proves a reverse match credits the campaign the lead was in WHEN THE BOOKING
// WAS MADE. A lead's campaign is where it lives now; leads are moved, and the
// July remarketing campaign took in everyone who had not replied, so February
// bookers were credited to a campaign that did not exist yet. The lead keeps its
// import campaign on payload.campaign. Drives the REAL /api/marketing/enrich
// handler against a throwaway Postgres, like attribution-stickiness.mjs:
//
//   initdb -D /tmp/pgc/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
//   node scripts/attribution-campaign-start.mjs
//
// Against the code before this script was added, A, B, B2 and H fail.
import pg from 'pg';

const P1  = 'a2a95058-21b8-41c4-8c39-a340976e66d3'; // Broader Church Campaign - Phase 1
const REM = '8552c05f-c927-48ee-b654-66f33e1c5cf1'; // Remarket FY27 - Non-Repliers
const NEW = '11111111-2222-4333-8444-555555555555'; // started after everything below
const CAMPAIGNS = {
  [P1]:  { name: 'Broader Church Campaign - Phase 1', timestamp_created: '2025-12-01T00:00:00Z' },
  [REM]: { name: 'Remarket FY27 - Non-Repliers',      timestamp_created: '2026-07-27T21:41:20Z' },
  [NEW]: { name: 'Brand New Campaign',                timestamp_created: '2026-10-01T00:00:00Z' },
};

// Where each lead lives now, and (payload.campaign) where it was imported.
const LEADS = {
  'ryan@restoration.org':  { campaign: REM, payload: { campaign: P1 } },
  'ron@tabernacle.org':    { campaign: REM, payload: { campaign: P1 } },
  'jack@trinity.org':      { campaign: REM, payload: { campaign: P1 } },
  'solo@nopayload.org':    { campaign: REM },
  'twice@moved.org':       { campaign: NEW, payload: { campaign: REM } },
  'utm@x.org':             { campaign: REM, payload: { campaign: P1 } },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('api.instantly.ai')) return realFetch(url, init);
  const json = (o) => new Response(JSON.stringify(o), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  if (u.includes('/campaigns')) {
    return json({ items: Object.entries(CAMPAIGNS).map(([id, c]) => ({ id, ...c })) });
  }
  if (u.includes('/leads/list')) {
    const term = String(JSON.parse(init.body || '{}').search || '').toLowerCase();
    const items = Object.entries(LEADS)
      .filter(([email]) => email === term)
      .map(([email, l]) => ({ email, campaign: l.campaign, payload: l.payload,
        timestamp_created: '2025-11-18T00:00:00Z', first_name: 'Lead', last_name: 'Person',
        company_name: 'Somewhere' }));
    return json({ items });
  }
  return json({ items: [] });
};

process.env.INSTANTLY_API_KEY = 'test-key';
delete process.env.CALENDLY_API_TOKEN;
process.env.BOOKING_SWEEP_MINUTES = '30000';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST || '/tmp/pgc/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

const routes = {};
const app = {
  get:   (p, h) => { routes[`GET ${p}`]   = h; },
  post:  (p, h) => { routes[`POST ${p}`]  = h; },
  put:   (p, h) => { routes[`PUT ${p}`]   = h; },
  patch: (p, h) => { routes[`PATCH ${p}`] = h; },
  delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  use:   () => {},
};
const { registerMarketing } = await import(process.env.TARGET || '../server/marketing.js');
registerMarketing(app, pool);
await new Promise(r => setTimeout(r, 800));

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

async function enrichAll() {
  const before = (await pool.query(
    'SELECT COALESCE(MAX(updated_at), NOW()) m FROM bookings')).rows[0].m;
  await call('POST /api/marketing/enrich', { query: { all: '1' } });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 100));
    const { rows } = await pool.query(
      `SELECT MAX(updated_at) m, COUNT(*) FILTER (WHERE enriched_at IS NULL) pending FROM bookings`);
    if (Number(rows[0].pending) === 0 && rows[0].m > before) return;
  }
  throw new Error('enrich sweep did not finish');
}

const get = async (id) => (await pool.query(
  `SELECT instantly_campaign_id cid, attribution_source src FROM bookings WHERE id=$1`, [id])).rows[0];

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

await pool.query('TRUNCATE bookings RESTART IDENTITY');
const add = async (key, email, bookedOn, extra = {}) => {
  const cols = ['calendly_uri', 'email', 'name', 'organization', 'booked_on', 'meeting_date'];
  const vals = [`cal/${key}`, email, 'Pat Booker', 'Some Church', bookedOn, bookedOn];
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  return (await pool.query(
    `INSERT INTO bookings (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals)).rows[0].id;
};

// A. February booking, lead since moved into Remarket (July): its import campaign.
const a = await add('a', 'ryan@restoration.org', '2026-02-02');
// B. The same mistake already stored, as the 2026-10-19 sweep left it.
const b = await add('b', 'ron@tabernacle.org', '2026-05-29',
  { instantly_campaign: CAMPAIGNS[REM].name, instantly_campaign_id: REM,
    attribution_source: 'reverse_name_org', enriched_at: new Date() });
// C. A September booking: Remarket was running, so Remarket it is.
const c = await add('c', 'jack@trinity.org', '2026-09-29');
// D. Nothing better to offer: the current campaign stands, as before.
const d = await add('d', 'solo@nopayload.org', '2026-03-01');
// E. The import campaign postdates the booking too: no better answer, unchanged.
const e = await add('e', 'twice@moved.org', '2026-05-01');
// F. A UTM tag is never second-guessed.
const f = await add('f', 'utm@x.org', '2026-03-01',
  { utm_source: 'instantly', utm_campaign: 'remarket-fy27' });
// G. Nor is a person's choice.
const g = await add('g', 'utm@x.org', '2026-03-02',
  { manual_override: JSON.stringify({ campaign: CAMPAIGNS[REM].name }) });
// H. A rescheduled booking is judged by the day it was first set.
const h = await add('h', 'jack@trinity.org', '2026-09-29', { originated_on: '2026-04-01' });

await enrichAll();
check('A  a moved lead credits its import campaign', (await get(a)).cid, P1);
check('B  a stored impossible match is corrected', (await get(b)).cid, P1);
check('C  a booking made while Remarket ran keeps Remarket', (await get(c)).cid, REM);
check('D  no import campaign: current campaign stands', (await get(d)).cid, REM);
check('E  import campaign also later: current campaign stands', (await get(e)).cid, NEW);
check('F  a UTM tag still wins', [(await get(f)).cid, (await get(f)).src], [REM, 'utm']);
check('G  a manual campaign still wins', [(await get(g)).cid, (await get(g)).src], [REM, 'manual']);
check('H  judged by the day first set', (await get(h)).cid, P1);

await enrichAll();
check('B2 a second sweep leaves it corrected', (await get(b)).cid, P1);
check('C2 and leaves Remarket where it was right', (await get(c)).cid, REM);

await pool.end();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
