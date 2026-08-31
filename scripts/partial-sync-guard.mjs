// Proves /api/marketing/sync/push refuses a delivery that is missing records,
// instead of accepting it and pruning the remainder away.
//
// A push is "the complete current set" by contract: anything absent is deleted.
// The existing rails miss a partial page -- it is neither empty nor half the
// table -- so a sender that stops at Salesforce's first page quietly deletes
// everything past it, every night. That is how two financials disappeared for
// nineteen days behind a delivery of 124 that looked entirely healthy.
//
// Case B is the one that matters: after a refused delivery the record that was
// NOT re-sent must still be in the table. Against the code before this guard,
// B and D and E all fail -- the short delivery is accepted and the missing row
// is pruned.
//
//   initdb -D /tmp/pgc/data -U postgres --auth=trust
//   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
//   node scripts/partial-sync-guard.mjs
//
// PGHOST overrides the socket directory; TARGET points at an alternate copy of
// the connector, which is how the before/after comparison is run.
import pg from 'pg';

const realFetch = globalThis.fetch;          // captured FIRST, before stubbing
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.instantly.ai') || u.includes('salesforce')) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, init);
};

delete process.env.ZAPIER_WEBHOOK_SECRET;    // no shared secret => no auth gate
delete process.env.CALENDLY_API_TOKEN;
process.env.BOOKING_SWEEP_MINUTES = '100000';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST || '/tmp/pgc/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

// Capture the real route handlers off a stubbed app. The push route mounts its
// own json parser ahead of the handler, so take the LAST function registered --
// the body is supplied already parsed.
const routes = {};
const add = (method) => (p, ...fns) => { routes[`${method} ${p}`] = fns[fns.length - 1]; };
const app = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), use: () => {} };

const { registerMarketing } = await import('../server/marketing.js');
const { registerSalesforceConnector } = await import(
  process.env.TARGET || '../server/connectors/salesforce.js');
registerMarketing(app, pool);
registerSalesforceConnector(app, pool);
await new Promise(r => setTimeout(r, 1000));  // let both ensureSchema calls finish

await pool.query(`CREATE TABLE IF NOT EXISTS letters (
  id SERIAL PRIMARY KEY, client_name TEXT, doc_tab TEXT,
  total_fee NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

const push = (body) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  Promise.resolve(routes['POST /api/marketing/sync/push'](
    { body, query: {}, params: {}, headers: {} }, res)).catch(reject);
});

const fin = (id, amount) => ({
  financial_id: id, name: `financial ${id}`, purpose: 'New Contract Signed',
  amount, upfront: 0, implementation: 0, created_date: '2026-01-15T00:00:00Z',
  opportunity_id: `006${id}`, organization: `Org ${id}`, non_security: false,
});

const stored = async () => (await pool.query(
  'SELECT financial_id FROM sf_financials ORDER BY financial_id')).rows.map(r => r.financial_id);

const lastRun = async () => (await pool.query(
  `SELECT ok, error FROM sync_runs WHERE source='salesforce_financials'
    ORDER BY started_at DESC LIMIT 1`)).rows[0] || {};

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

await pool.query('TRUNCATE sf_financials');
await pool.query('TRUNCATE sync_runs');

// A. a sender that states nothing is trusted exactly as before
let r = await push({ source: 'salesforce_financials', records: [fin('A1', 100), fin('A2', 200), fin('A3', 300)] });
check('A  a delivery with no stated total is accepted', r.status, 200);
check('A2 and all three are stored', await stored(), ['A1', 'A2', 'A3']);

// B. THE CASE: a short delivery must be refused, and must not prune the rest
r = await push({ source: 'salesforce_financials', totalSize: 3, records: [fin('A1', 100), fin('A2', 200)] });
check('B  a delivery short of its own totalSize is refused', r.status, 409);
check('B2 the record it omitted is NOT deleted', await stored(), ['A1', 'A2', 'A3']);
check('B3 and the refusal is recorded as a failed run', (await lastRun()).ok, false);
console.log(`        recorded error: ${(await lastRun()).error}`);

// C. a complete delivery still applies, prune included
r = await push({ source: 'salesforce_financials', totalSize: 2, records: [fin('A1', 100), fin('A2', 200)] });
check('C  a complete delivery is accepted', r.status, 200);
check('C2 and prunes what it genuinely dropped', await stored(), ['A1', 'A2']);

// D. done:false is Salesforce saying "there are more pages"
r = await push({ source: 'salesforce_financials', done: false, records: [fin('A1', 100)] });
check('D  done:false is refused even without a total', r.status, 409);
check('D2 and nothing is pruned', await stored(), ['A1', 'A2']);

// E. the same facts inside Zapier's raw-request envelope
r = await push({ source: 'salesforce_financials',
                 results: [{ body: { totalSize: 2, done: false, records: [fin('A1', 100)] } }] });
check('E  a short delivery inside a raw envelope is refused', r.status, 409);
check('E2 and nothing is pruned', await stored(), ['A1', 'A2']);

// F. done:true with a matching total is the healthy shape
r = await push({ source: 'salesforce_financials', totalSize: 2, done: true,
                 records: [fin('A1', 100), fin('A2', 200)] });
check('F  done:true with a matching total is accepted', r.status, 200);

await pool.end();
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
