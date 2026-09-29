#!/usr/bin/env node
/*
 * Correcting a booking's organization so it matches its Salesforce win.
 *
 * Centerpoint Church in Colton signed for $9,500 on 2026-08-31, and the win
 * never reached the funnel. Its booking says "Centerppoint Church", because that
 * is what the invitee typed into Calendly. The booking's email is at
 * centerpointcolton.com and Salesforce has centerpointchurch.church, so neither
 * the domain match nor the name match could find it. There was no way to correct
 * the name, and a direct database edit would not have lasted: every Calendly
 * re-import wrote the invitee's answer back.
 *
 * PATCH /api/marketing/bookings/:id now takes `organization`:
 *   - the corrected name goes on the booking, where every matcher reads it;
 *   - unmatched wins and financials are matched again straight away;
 *   - a Calendly re-import keeps the correction;
 *   - '' drops the correction, and the next import brings the typed name back.
 *
 * Runs the real route handlers against a throwaway Postgres:
 *   initdb -D /tmp/pgc/data -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
 *   node scripts/booking-org-fix.mjs
 */
import pg from 'pg';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.instantly.ai') || u.includes('salesforce') || u.includes('calendly')) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, init);
};
process.env.ZAPIER_WEBHOOK_SECRET = 'bof-secret';
delete process.env.CALENDLY_API_TOKEN;
delete process.env.INSTANTLY_API_KEY;
process.env.BOOKING_SWEEP_MINUTES = '30000';   // ~3 weeks: the most a Node timer holds (2^31 ms); above it, it fires every 1 ms

const pool = new pg.Pool({
  host: process.env.PGHOST || '/tmp/pgc/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

await pool.query(`DROP TABLE IF EXISTS bookings, sf_wins, sf_financials, sync_runs, letters CASCADE`);
await pool.query(`CREATE TABLE letters (
  id SERIAL PRIMARY KEY, client_name TEXT, doc_tab TEXT,
  total_fee NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`);

const routes = {};
const add = (method) => (p, ...fns) => { routes[`${method} ${p}`] = fns[fns.length - 1]; };
const app = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), use: () => {} };
const { registerMarketing } = await import('../server/marketing.js');
const { registerSalesforceConnector } = await import('../server/connectors/salesforce.js');
registerMarketing(app, pool);
registerSalesforceConnector(app, pool);
await new Promise((r) => setTimeout(r, 1200));   // both ensureSchema calls

const call = (key, { body = {}, params = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  const req = { body, params, query, headers: { 'x-zap-secret': 'bof-secret' },
    get(h) { return this.headers[String(h).toLowerCase()]; } };
  Promise.resolve(routes[key](req, res)).catch(reject);
});
const patch = (id, body) => call('PATCH /api/marketing/bookings/:id', { params: { id: String(id) }, body });
const ingest = (body) => call('POST /api/marketing/bookings/ingest', { body });
const push = (source, records) => call('POST /api/marketing/sync/push', { body: { source, records } });

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const booking = async (id) => (await pool.query(
  `SELECT organization, won, became_client, fee::float AS fee, exclusion_reason,
          manual_override->>'organization' AS org_override
     FROM bookings WHERE id=$1`, [id])).rows[0];
const winLink = async (opp) => (await pool.query(
  `SELECT booking_id FROM sf_wins WHERE opportunity_id=$1`, [opp])).rows[0]?.booking_id ?? null;
const finLink = async (fid) => (await pool.query(
  `SELECT booking_id FROM sf_financials WHERE financial_id=$1`, [fid])).rows[0]?.booking_id ?? null;

// ── the Centerpoint booking, as it arrived from Calendly: typo, cancelled ──────
const CAL = 'https://api.calendly.com/scheduled_events/ev-centerpoint/invitees/inv-1';
const first = await ingest({
  calendly_uri: CAL, booked_on: '2026-07-27T16:47:09Z', meeting_date: '2026-07-29T17:00:00Z',
  name: 'Pamela Alexander', email: 'pam@centerpointcolton.com', organization: 'Centerppoint Church',
});
const id = first.body.id;
await new Promise((r) => setTimeout(r, 300));   // ingest enriches in the background
await pool.query(`UPDATE bookings SET cancelled=TRUE, held=NULL, exclusion_reason='cancelled' WHERE id=$1`, [id]);
// Someone else entirely, to show a correction links only what matches it.
const other = (await ingest({
  calendly_uri: 'https://api.calendly.com/scheduled_events/ev-other/invitees/inv-2',
  booked_on: '2026-07-20T12:00:00Z', meeting_date: '2026-07-22T12:00:00Z',
  name: 'Someone Else', email: 'x@gracechapel.org', organization: 'Grace Chapel',
})).body.id;
await new Promise((r) => setTimeout(r, 300));   // ingest enriches in the background

await push('salesforce_wins', [
  { opportunity_id: '006CENTER', organization: 'Centerpoint Church Colton',
    domain: 'centerpointchurch.church', amount: 9500, close_date: '2026-08-31' },
  { opportunity_id: '006ELSEWHERE', organization: 'Unrelated Fellowship',
    domain: 'unrelated.org', amount: 12000, close_date: '2026-08-01' },
]);

// ── A. before: the typo keeps the win untracked ──────────────────────────────
check('A  the win is untracked while the booking says "Centerppoint"', await winLink('006CENTER'), null);
check('A2 and the booking is still an excluded cancellation',
  [(await booking(id)).won, (await booking(id)).exclusion_reason], [false, 'cancelled']);

// ── B. the correction ────────────────────────────────────────────────────────
const r = await patch(id, { organization: '  Centerpoint Church ' });
check('B  PATCH accepts organization', r.status, 200);
check('B2 and says how many records it matched', r.body.relinked, 1);
const b = await booking(id);
check('B3 the booking carries the corrected name, trimmed', b.organization, 'Centerpoint Church');
check('B4 and records it as a correction', b.org_override, 'Centerpoint Church');
check('B5 the win now points at the booking', await winLink('006CENTER'), id);
check('B6 the booking is won, a client, at the Salesforce amount, no longer excluded',
  [b.won, b.became_client, b.fee, b.exclusion_reason], [true, true, 9500, null]);
check('B7 an unrelated untracked win stays untracked', await winLink('006ELSEWHERE'), null);
check('B8 an unrelated booking is untouched', (await booking(other)).won, false);

// ── C. Calendly sends the invitee's answer again ─────────────────────────────
await ingest({ calendly_uri: CAL, organization: 'Centerppoint Church', email: 'pam@centerpointcolton.com' });
check('C  a re-import keeps the correction', (await booking(id)).organization, 'Centerpoint Church');
await push('salesforce_wins', [
  { opportunity_id: '006CENTER', organization: 'Centerpoint Church Colton',
    domain: 'centerpointchurch.church', amount: 9500, close_date: '2026-08-31' },
  { opportunity_id: '006ELSEWHERE', organization: 'Unrelated Fellowship',
    domain: 'unrelated.org', amount: 12000, close_date: '2026-08-01' },
]);
check('C2 and the next Salesforce sync keeps the link', await winLink('006CENTER'), id);
check('C3 an uncorrected booking still takes Calendly\'s answer',
  (await ingest({ calendly_uri: 'https://api.calendly.com/scheduled_events/ev-other/invitees/inv-2',
                  organization: 'Grace Chapel Church' }), (await booking(other)).organization),
  'Grace Chapel Church');

// ── D. a financial record waiting on the same booking ────────────────────────
await pool.query(`INSERT INTO sf_financials (financial_id, purpose, amount, organization, domain)
                  VALUES ('a0FUNMATCHED', 'New Contract', 4000, 'Grace Chapel Church Riverside', 'gracechapelriverside.org')`);
const d = await patch(other, { organization: 'Grace Chapel Church Riverside' });
check('D  an unmatched financial record is matched too', [d.body.relinked, await finLink('a0FUNMATCHED')], [1, other]);

// ── E. the other fields behave as before ─────────────────────────────────────
const e = await patch(other, { held: true });
check('E  a PATCH without organization does not relink or report it', [e.status, 'relinked' in e.body], [200, false]);
check('E2 and leaves the corrected name alone', (await booking(other)).organization, 'Grace Chapel Church Riverside');

// ── F. dropping the correction ───────────────────────────────────────────────
await patch(id, { organization: '' });
check('F  "" drops the correction but not the name, until the next import',
  [(await booking(id)).org_override, (await booking(id)).organization], [null, 'Centerpoint Church']);
await ingest({ calendly_uri: CAL, organization: 'Centerppoint Church' });
check('F2 the next import brings back what the invitee typed', (await booking(id)).organization, 'Centerppoint Church');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
await pool.end();
process.exit(passed === results.length ? 0 : 1);
