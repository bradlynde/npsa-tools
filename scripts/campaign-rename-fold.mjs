// Proves a renamed Instantly campaign stops splitting the campaign table.
//
// A booking enriched before a rename keeps the name Instantly used then, and one
// enriched before instantly_campaign_id existed keeps no id at all. The fold in
// /api/marketing/by-campaign groups on the id and falls back to the stored name --
// so those rows label themselves with a name no live campaign answers to, and each
// gets its own row. Three renamed campaigns were showing as three separate
// one-booking campaigns on the dashboard when this was written.
//
// The id backfill could not fix them either: it resolves the stored name against
// Instantly's CURRENT names, and a dead name is precisely one that is no longer in
// that list. Case B is the assertion that matters -- it fails against the code
// before this change, because the sweep leaves the id null for ever.
//
//   initdb -D /tmp/pgr/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgr/data -o '-k /tmp/pgr/sock -c listen_addresses=' start
//   node scripts/campaign-rename-fold.mjs
//
// PGHOST overrides the socket directory; TARGET points at an alternate copy of
// marketing.js, which is how the before/after comparison is run.
import pg from 'pg';

// The three live campaigns this test touches, exactly as Instantly returns them.
// The dead names below are what the same campaigns used to be called.
const LIVE = {
  '8552c05f-c927-48ee-b654-66f33e1c5cf1': 'Remarket FY27 - Non-Repliers',
  '28c9205e-23fe-4e10-b5fc-839cb2e9f0ab': 'CA Outreach - CSNSGP FY26',
  'e16e3d42-d3bc-40ce-88e8-756b2aa79ee8': 'IL Outreach - Uncontacted',
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.instantly.ai/api/v2/campaigns')) {
    return new Response(
      JSON.stringify({ items: Object.entries(LIVE).map(([id, name]) => ({ id, name })) }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.instantly.ai') || u.includes('calendly.com')) {
    return new Response(JSON.stringify({ items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

process.env.INSTANTLY_API_KEY = 'test-key';   // the map returns {} without one
delete process.env.ZAPIER_WEBHOOK_SECRET;
delete process.env.CALENDLY_API_TOKEN;
process.env.BOOKING_SWEEP_MINUTES = '100000';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST || '/tmp/pgr/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

const routes = {};
const add = (m) => (p, ...fns) => { routes[`${m} ${p}`] = fns[fns.length - 1]; };
const app = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), use: () => {} };

const { registerMarketing } = await import(process.env.TARGET || '../server/marketing.js');
registerMarketing(app, pool);
await new Promise(r => setTimeout(r, 1000));   // let ensureSchema finish

await pool.query(`CREATE TABLE IF NOT EXISTS letters (
  id SERIAL PRIMARY KEY, client_name TEXT, doc_tab TEXT,
  total_fee NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

const call = (route, body = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve(b); return this; },
  };
  Promise.resolve(routes[route]({ body, query: {}, params: {}, headers: {} }, res)).catch(reject);
});

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// Four bookings. Three carry a dead name and no id -- the shape a rename leaves
// behind. The fourth carries the live id, so it is what the dead-named Remarket
// row has to fold together WITH rather than merely alongside.
await pool.query('TRUNCATE bookings');
await pool.query(`
  INSERT INTO bookings (calendly_uri, booked_on, meeting_date, email, organization,
                        instantly_campaign, instantly_campaign_id, attribution_source, held)
  VALUES
    ('u1','2026-08-18','2026-08-20','a@x.org','Gilead Church',
     'Remarket FY27 - Non-Repliers (excl IL, CA)', NULL, 'manual', TRUE),
    ('u2','2026-08-11','2026-08-18','b@x.org','Redeemer Baptist Church',
     'CA Outreach - CSNSGP FY26 (6-step)',        NULL, 'manual', TRUE),
    ('u3','2026-08-10','2026-08-13','c@x.org','Trinity Church Chicago',
     'IL Outreach - Uncontacted (6-step)',        NULL, 'manual', TRUE),
    ('u4','2026-08-23','2026-08-26','d@x.org','Kenosha Bible Church',
     'Remarket FY27 - Non-Repliers',
     '8552c05f-c927-48ee-b654-66f33e1c5cf1', 'utm', TRUE)`);

const byCampaign = async () => {
  const rows = await call('GET /api/marketing/by-campaign');
  return Object.fromEntries(rows.filter(r => r.is_campaign).map(r => [r.campaign, r.booked]));
};

// A. THE CASE: three renamed campaigns, three dead names, and not one of them may
//    survive as a campaign of its own.
const grouped = await byCampaign();
check('A  no dead campaign name survives the fold',
  Object.keys(grouped).filter(n => /\(6-step\)|\(excl IL, CA\)/.test(n)), []);
check('A2 the renamed Remarket row folds INTO the live one, not beside it',
  grouped['Remarket FY27 - Non-Repliers'], 2);
check('A3 and the other two land on their live campaigns',
  [grouped['CA Outreach - CSNSGP FY26'], grouped['IL Outreach - Uncontacted']], [1, 1]);
check('A4 leaving three campaigns, not six', Object.keys(grouped).length, 3);

// B. The id backfill can now resolve a dead name, so these rows stop being
//    selected by NEEDS_CAMPAIGN_ID on every sweep for ever.
await call('POST /api/marketing/enrich', {});
const { rows: [{ missing }] } = await pool.query(
  `SELECT COUNT(*)::int AS missing FROM bookings
    WHERE instantly_campaign IS NOT NULL AND instantly_campaign_id IS NULL`);
check('B  enrichment backfills the id from the dead name', missing, 0);

// C. A rename must not move a booking. The id it lands on is the live campaign's.
const { rows: [{ cid }] } = await pool.query(
  `SELECT instantly_campaign_id AS cid FROM bookings WHERE calendly_uri='u3'`);
check('C  and it is the right campaign, not merely some campaign',
  cid, 'e16e3d42-d3bc-40ce-88e8-756b2aa79ee8');

// D. npsa-church-outreach is Remarket FY27's second sending slug. Unmapped, it
//    titled itself into "NPSA Church Outreach" -- a fourteenth campaign nobody has.
await pool.query('TRUNCATE bookings');
await pool.query(`
  INSERT INTO bookings (calendly_uri, booked_on, meeting_date, email, organization,
                        utm_source, utm_campaign, held)
  VALUES ('u5','2026-08-06','2026-08-13','e@x.org','Ransom Church',
          'instantly','npsa-church-outreach', TRUE)`);
await call('POST /api/marketing/enrich', {});
const { rows: [slug] } = await pool.query(
  `SELECT instantly_campaign AS name, instantly_campaign_id AS cid FROM bookings WHERE calendly_uri='u5'`);
check('D  npsa-church-outreach resolves to Remarket FY27, not a new campaign',
  [slug.name, slug.cid],
  ['Remarket FY27 - Non-Repliers', '8552c05f-c927-48ee-b654-66f33e1c5cf1']);

await pool.end();
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
