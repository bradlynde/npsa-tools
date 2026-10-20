// Proves what a booker tells us outranks a guessed campaign. Drives the REAL
// /api/marketing/enrich handler against a throwaway Postgres, like
// attribution-stickiness.mjs, and is run the same way:
//
//   initdb -D /tmp/pgc/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
//   node scripts/attribution-self-report.mjs
//
// Evidence, strongest first: utm, an exact email match, the "How did you hear
// about us?" answer, then a domain or name match. A named event beats an exact
// email match as well. Against the code before this script was added, G, K, N, O
// and both second sweeps fail -- Storyline, Life Valley and Sagemont as credited.
import pg from 'pg';

const REM = '8552c05f-c927-48ee-b654-66f33e1c5cf1'; // Remarket FY27 - Non-Repliers
const NAMES = { [REM]: 'Remarket FY27 - Non-Repliers' };

// One colleague per church sits in Remarket; the bookers themselves mostly do not.
const LEADS = {
  'pastor@storyline.org':  { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
  'office@harvest.org':    { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
  'admin@swisscove.org':   { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
  'admin@lifevalley.org':  { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
  'scott@sagemont.org':    { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
  'cole@redeemer.org':     { campaign: REM, timestamp_created: '2026-07-27T00:00:00Z' },
};

const realFetch = globalThis.fetch;
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
    const term = String(JSON.parse(init.body || '{}').search || '').toLowerCase();
    const items = Object.entries(LEADS)
      .filter(([email]) => email.includes(term) || term.includes(email.split('@')[1] || ' '))
      .map(([email, l]) => ({ email, campaign: l.campaign, timestamp_created: l.timestamp_created,
        first_name: 'Lead', last_name: 'Colleague', company_name: 'Somewhere Else' }));
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
  `SELECT attribution_channel ch, instantly_campaign_id cid, attribution_source src
     FROM bookings WHERE id=$1`, [id])).rows[0];

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const shape = (r) => [r.ch, r.cid, r.src];

await pool.query('TRUNCATE bookings RESTART IDENTITY');
const add = async (key, email, toldUs, extra = {}) => {
  const cols = ['calendly_uri', 'email', 'name', 'organization', 'booked_on', 'meeting_date', 'told_us'];
  const vals = [`cal/${key}`, email, 'Pat Booker', 'Some Church', '2026-09-20', '2026-09-25', toldUs];
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  return (await pool.query(
    `INSERT INTO bookings (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals)).rows[0].id;
};

const g = await add('g', 'dg@storyline.org', 'Referred by someone I know');
const h = await add('h', 'mandy@harvest.org', 'Email from Nonprofit Security Advisors');
const i = await add('i', 'mm@swisscove.org', 'Other');
const j = await add('j', 'cole@redeemer.org', 'Referred by someone I know');
const k = await add('k', 'scott@sagemont.org', 'CITN');
const l = await add('l', 'utm@storyline.org', 'Referred by someone I know',
  { utm_source: 'instantly', utm_campaign: 'remarket-fy27' });
const m = await add('m', 'man@storyline.org', 'Referred by someone I know',
  { manual_override: JSON.stringify({ campaign: NAMES[REM] }) });
// A row credited before this rule existed: the sticky path must not shield it.
const n = await add('n', 'info@lifevalley.org', 'Google search',
  { instantly_campaign: NAMES[REM], instantly_campaign_id: REM,
    attribution_source: 'reverse_domain', enriched_at: new Date() });
const o = await add('o', 'staff@storyline.org', 'Met us at a conference or event');

await enrichAll();
check('G  domain match + "Referred" -> referral', shape(await get(g)), ['referral', null, 'self_report']);
check('H  domain match + "Email from NPSA" -> kept on Instantly', shape(await get(h)), ['instantly', REM, 'reverse_domain']);
check('I  domain match + "Other" -> kept on Instantly', shape(await get(i)), ['instantly', REM, 'reverse_domain']);
check('J  exact email + "Referred" -> Instantly', shape(await get(j)), ['instantly', REM, 'reverse_email']);
check('K  exact email + "CITN" -> conference', shape(await get(k)), ['conference', null, 'self_report']);
check('L  utm + "Referred" -> Instantly', shape(await get(l)), ['instantly', REM, 'utm']);
check('M  manual campaign + "Referred" -> Instantly', shape(await get(m)), ['instantly', REM, 'manual']);
check('N  stored domain credit + "Google search" -> search', shape(await get(n)), ['search', null, 'self_report']);
check('O  domain match + conference answer -> conference', shape(await get(o)), ['conference', null, 'self_report']);

await enrichAll();
check('G2 a second sweep lands in the same place', shape(await get(g)), ['referral', null, 'self_report']);
check('K2 and so does Sagemont', shape(await get(k)), ['conference', null, 'self_report']);

await pool.end();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
