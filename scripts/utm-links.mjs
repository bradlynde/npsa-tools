// The Links panel's API: the builder preview, saving and deleting links, and the
// list of tag combinations seen on bookings. Drives the REAL route handlers against
// a throwaway Postgres, like attribution-stickiness.mjs, and is run the same way:
//
//   initdb -D /tmp/pgc/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
//   node scripts/utm-links.mjs
import pg from 'pg';

const REM = '8552c05f-c927-48ee-b654-66f33e1c5cf1';
const NAMES = { [REM]: 'Remarket FY27 - Non-Repliers' };

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
  get:    (p, h) => { routes[`GET ${p}`]    = h; },
  post:   (p, h) => { routes[`POST ${p}`]   = h; },
  put:    (p, h) => { routes[`PUT ${p}`]    = h; },
  patch:  (p, h) => { routes[`PATCH ${p}`]  = h; },
  delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  use:    () => {},
};
const { registerMarketing } = await import(process.env.TARGET || '../server/marketing.js');
registerMarketing(app, pool);
await new Promise(r => setTimeout(r, 800));

const call = (key, req = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  Promise.resolve(routes[key]({ query: {}, body: {}, params: {}, headers: {}, ...req }, res))
    .catch(reject);
});
const preview = (q) => call('GET /api/marketing/links/preview', { query: q });

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const CHAD = 'https://calendly.com/chad-nonprofitsecurityadvisors/new-meeting';

let p = await preview({ base_url: CHAD, utm_source: 'church_it_network', utm_medium: 'in_person_event',
  utm_campaign: 'citn_2026', utm_content: 'printed_material' });
check('P1 the CITN tags preview as Conference, CITN 2026',
  [p.body.credit.label, p.body.credit.detail, p.body.warnings.length], ['Conference', 'CITN 2026', 0]);
check('P1b and build the URL Michael used', p.body.url,
  `${CHAD}?utm_source=church_it_network&utm_medium=in_person_event&utm_campaign=citn_2026&utm_content=printed_material`);

p = await preview({ base_url: CHAD, utm_source: 'instantly', utm_medium: 'email', utm_campaign: 'remarket-fy27' });
check('P2 a mapped Instantly slug names its campaign', [p.body.credit.detail, p.body.warnings], ['Remarket FY27 - Non-Repliers', []]);

p = await preview({ base_url: CHAD, utm_source: 'instantly', utm_medium: 'email', utm_campaign: 'brand-new-push' });
check('P3 an unmapped slug is flagged', p.body.warnings.some(w => w.includes('not mapped')), true);

p = await preview({ base_url: 'https://calendly.com/jeff-nonprofitsecurityadvisors/30min-jeff-follow-up',
  utm_source: 'jeff', utm_medium: 'email' });
check('P4 an untracked Calendly link is flagged', p.body.warnings[0].includes('not one the dashboard ingests'), true);
check('P4b a rep email tag reads as Email, with the lookup caveat', [p.body.credit.label, !!p.body.note], ['Email', true]);

p = await preview({ base_url: CHAD, utm_source: 'Mystery Source', utm_medium: 'Flyer' });
check('P5 tags are slugged', [p.body.utm.utm_source, p.body.utm.utm_medium], ['mystery-source', 'flyer']);
check('P5b an unknown medium warns it will count as Direct', p.body.warnings.some(w => w.includes('Direct / Other')), true);

const post = (body) => call('POST /api/marketing/links', { body, actor: 'stuart' });
check('S1 a name is required', (await post({ base_url: CHAD, utm_source: 'a', utm_medium: 'b' })).status, 400);
check('S2 the URL must be http(s)', (await post({ label: 'x', base_url: 'calendly.com/x', utm_source: 'a', utm_medium: 'b' })).status, 400);
check('S3 source and medium are required', (await post({ label: 'x', base_url: CHAD, utm_source: 'a' })).status, 400);
const saved = await post({ label: 'CITN 2026 flyer', base_url: CHAD, utm_source: 'church_it_network',
  utm_medium: 'in_person_event', utm_campaign: 'CITN 2026' });
check('S4 a valid link saves, slugged', [saved.status, saved.body.link.utm_campaign], [200, 'citn-2026']);

await pool.query('TRUNCATE bookings RESTART IDENTITY');
await pool.query(
  `INSERT INTO bookings (calendly_uri, email, booked_on, utm_source, utm_medium, utm_campaign, attribution_channel, exclusion_reason) VALUES
   ('cal/1','a@x.org','2026-10-01','church_it_network','in_person_event','citn-2026','conference',NULL),
   ('cal/2','b@x.org','2026-10-02','church_it_network','in_person_event','citn-2026','conference','cancelled'),
   ('cal/3','c@x.org','2026-10-03','Instantly','email','remarket-fy27','instantly',NULL),
   ('cal/4','d@x.org','2026-10-04','instantly','email','remarket-fy27','instantly',NULL),
   ('cal/5','e@x.org','2026-10-05','google','organic',NULL,'search',NULL),
   ('cal/6','f@x.org','2026-10-06','google','organic',NULL,'instantly',NULL),
   ('cal/7','g@x.org','2026-10-07',NULL,NULL,NULL,'direct',NULL)`);

const list = (await call('GET /api/marketing/links')).body;
const mine = list.saved.find(l => l.label === 'CITN 2026 flyer');
check('L1 a saved link counts the bookings carrying its tags', [mine.bookings, mine.counted], [2, 1]);
check('L1b and gives its finished URL', mine.url.includes('utm_campaign=citn-2026'), true);
const rem = list.seen.find(s => s.utm_campaign === 'remarket-fy27');
check('L2 seen combos merge case variants', rem.bookings, 2);
const org = list.seen.find(s => s.utm_source === 'google');
check('L3 seen combos report how bookings were really credited', org.credited_as, { 'Organic Search': 1, Instantly: 1 });
check('L4 a saved combo is not repeated under seen', list.seen.some(s => s.utm_campaign === 'citn-2026'), false);
check('L5 untagged bookings are not listed', list.seen.length, 2);
check('L6 one slug per Instantly campaign', list.instantly.filter(i => i.name === NAMES[REM]).length, 1);
check('L7 the four intro links are the booking presets', list.presets.booking.length, 4);

const del = (id) => call('DELETE /api/marketing/links/:id', { params: { id: String(id) } });
check('D1 a link deletes', (await del(mine.id)).status, 200);
check('D2 and is gone', (await del(mine.id)).status, 404);

await pool.end();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
