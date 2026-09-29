#!/usr/bin/env node
/*
 * What a Salesforce win does to the marketing funnel.
 *
 * On 2026-09-28, 19 of the 34 bookings with a Salesforce win were not counted as
 * clients ($407,250): "client" meant an LOE saved in the generator, and a contract
 * signed any other way did not count. A booking cancelled in Calendly stayed
 * excluded even after the organization signed (United Church of Hyde Park, $15,000,
 * in no figure at all). The rules Stuart settled on, all in settleOutcomes():
 *
 *   - a win makes the booking a client, with the letter's fee if there is one and
 *     the won amount otherwise, and fee_source saying which;
 *   - a win clears a cancellation, but not a reschedule (that row was replaced);
 *   - a person's Held/LOE tick or exclusion still stands;
 *   - all of it reverses when the win goes away.
 *
 * Also the two smaller items from the same audit: the untracked wins split into
 * returning clients and real gaps, and the no-show count behind held_rate.
 *
 * Runs the real route handlers against a throwaway Postgres:
 *   initdb -D /tmp/pgc/data -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgc/data -o '-k /tmp/pgc/sock -c listen_addresses=' start
 *   node scripts/win-outcomes.mjs
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
process.env.ZAPIER_WEBHOOK_SECRET = 'wo-secret';
delete process.env.CALENDLY_API_TOKEN;
delete process.env.INSTANTLY_API_KEY;
process.env.BOOKING_SWEEP_MINUTES = '30000';   // ~3 weeks: the most a Node timer holds (2^31 ms); above it, it fires every 1 ms

const pool = new pg.Pool({
  host: process.env.PGHOST || '/tmp/pgc/sock',
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'postgres',
});

// Start from nothing, so a table left by another harness cannot decide a result.
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
  const req = { body, params, query, headers: { 'x-zap-secret': 'wo-secret' },
    get(h) { return this.headers[String(h).toLowerCase()]; } };
  Promise.resolve(routes[key](req, res)).catch(reject);
});
const pushWins = (records) => call('POST /api/marketing/sync/push', { body: { source: 'salesforce_wins', records } });
const stats = async () => (await call('GET /api/marketing/stats')).body;
// fee_source read through to_jsonb so a build without the column reports failed
// checks rather than a crash — the point of running this against the parent.
const row = async (id) => (await pool.query(
  `SELECT became_client, fee::float AS fee, to_jsonb(b)->>'fee_source' AS fee_source, exclusion_reason
     FROM bookings b WHERE id=$1`, [id])).rows[0];

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const booking = async (b) => (await pool.query(
  `INSERT INTO bookings (booked_on, meeting_date, name, email, organization, held,
                         cancelled, exclusion_reason, rescheduled_to, manual_override, attribution_channel)
   VALUES (NOW() - interval '20 days', NOW() - interval '10 days', 'Someone', $1, $2, $3,
           $4, $5, $6, $7, 'instantly') RETURNING id`,
  [b.email, b.org, b.held ?? true, b.cancelled ?? false, b.exclusion ?? null,
   b.rescheduledTo ?? null, JSON.stringify(b.override ?? {})])).rows[0].id;
const win = (id, org, domain, amount, close = '2026-08-01') =>
  ({ opportunity_id: id, organization: org, domain, amount, close_date: close });

// ── the bookings ─────────────────────────────────────────────────────────────
const plain = await booking({ email: 'a@plain.org', org: 'Plain Church' });                 // no letter, wins
const lettered = await booking({ email: 'b@lettered.org', org: 'Lettered Church' });        // letter + win
await pool.query(`INSERT INTO letters (client_name, doc_tab, total_fee) VALUES ('Lettered Church', 'pre', 12000)`);
await pool.query(`UPDATE bookings SET client_letter_id = (SELECT id FROM letters), became_client = TRUE, fee = 12000
                   WHERE id = $1`, [lettered]);
const cancelled = await booking({ email: 'c@hydepark.org', org: 'United Church of Hyde Park',
                                  held: null, cancelled: true, exclusion: 'cancelled' });
const moved = await booking({ email: 'd@moved.org', org: 'Moved Church', held: null,
                              cancelled: true, exclusion: 'rescheduled', rescheduledTo: plain });
const saidNo = await booking({ email: 'e@saidno.org', org: 'Said No Church',
                               override: { became_client: false } });
const unqualified = await booking({ email: 'f@unq.org', org: 'Unqualified Org',
                                    exclusion: 'unqualified', override: { exclusion: 'unqualified' } });
const bystander = await booking({ email: 'g@bystander.org', org: 'Bystander Church', held: false });
const before = await row(bystander);
const statsBefore = await stats();

let r = await pushWins([
  win('006PLAIN', 'Plain Church', 'plain.org', 9500),
  win('006LETTER', 'Lettered Church', 'lettered.org', 14000),
  win('006HYDE', 'United Church of Hyde Park', 'hydepark.org', 15000),
  win('006MOVED', 'Moved Church', 'moved.org', 8000),
  win('006SAIDNO', 'Said No Church', 'saidno.org', 7000),
  win('006UNQ', 'Unqualified Org', 'unq.org', 6000),
]);
check('the wins are accepted', r.status, 200);

// ── item 1: a win makes a client ─────────────────────────────────────────────
check('1A a won booking with no letter is a client', (await row(plain)).became_client, true);
check('1B and its fee is the won amount, from Salesforce',
  [(await row(plain)).fee, (await row(plain)).fee_source], [9500, 'salesforce']);
check('1C a won booking WITH a letter keeps the letter fee',
  [(await row(lettered)).fee, (await row(lettered)).fee_source], [12000, 'letter']);
check('1D a person who unticked LOE is not overruled', (await row(saidNo)).became_client, false);

// ── item 2: a win clears a cancellation ──────────────────────────────────────
check('2A a cancelled booking that won is counted again', (await row(cancelled)).exclusion_reason, null);
check('2B and is a client at the won amount',
  [(await row(cancelled)).became_client, (await row(cancelled)).fee], [true, 15000]);
check('2C a RESCHEDULED row that won stays excluded (its replacement carries it)',
  (await row(moved)).exclusion_reason, 'rescheduled');
check('2D an exclusion a person chose stays', (await row(unqualified)).exclusion_reason, 'unqualified');
check('2E a booking with no win is untouched', await row(bystander), before);

const s = await stats();
check('the funnel counts the cancelled-then-won booking',
  s.total_bookings - statsBefore.total_bookings, 1);
check('fees split by source', [s.fees_from_salesforce, s.fees_from_letters], [9500 + 15000, 12000]);
check('total_fees_won is still the whole', s.total_fees_won, 9500 + 15000 + 12000);

// ── the enrichment path settles too ──────────────────────────────────────────
// A Held/LOE tick re-enriches the booking; its letter match knows nothing of
// Salesforce, and must not undo the win.
r = await call('PATCH /api/marketing/bookings/:id', { params: { id: String(plain) }, body: { held: true } });
check('re-enrichment keeps the won booking a client',
  [r.status, (await row(plain)).became_client, (await row(plain)).fee_source], [200, true, 'salesforce']);

// ── and it all reverses when a win goes away ────────────────────────────────
r = await pushWins([
  win('006LETTER', 'Lettered Church', 'lettered.org', 14000),
  win('006MOVED', 'Moved Church', 'moved.org', 8000),
  win('006SAIDNO', 'Said No Church', 'saidno.org', 7000),
  win('006UNQ', 'Unqualified Org', 'unq.org', 6000),
]);
check('a full delivery without two wins is accepted', r.status, 200);
check('R1 the booking that was a client only by its win no longer is',
  await row(plain), { became_client: false, fee: 0, fee_source: null, exclusion_reason: null });
check('R2 the cancellation the win had cleared comes back', (await row(cancelled)).exclusion_reason, 'cancelled');
check('R3 the lettered booking is still a client on its letter',
  [(await row(lettered)).became_client, (await row(lettered)).fee_source], [true, 'letter']);

// ── item 3: the no-show count behind held_rate ───────────────────────────────
check('3  no_show_count reports meetings marked not held', (await stats()).no_show_count, 1);
check('3B and with one recorded, held_rate carries no warning', (await stats()).held_rate_note, null);
await pool.query(`UPDATE bookings SET held = TRUE WHERE held IS FALSE`);
check('3C with none recorded, held_rate says it is not an attendance rate',
  /not an attendance rate/.test((await stats()).held_rate_note || ''), true);

// ── item 4: returning clients split from real gaps ───────────────────────────
await pushWins([
  win('006LETTER', 'Lettered Church', 'lettered.org', 14000),
  win('006MCL1', 'McLean Bible Church', 'mcleanbible.org', 41250, '2025-07-02'),
  win('006MCL2', 'McLean Bible Church', 'mcleanbible.org', 27000, '2026-07-29'),
  win('006NEW', 'Brand New Church', 'brandnew.org', 12000, '2026-08-10'),
  win('006NAME1', 'Killian Hill Baptist Church', null, 13500, '2025-11-06'),
  win('006NAME2', 'Killian Hill Baptist Church', null, 10500, '2026-05-12'),
]);
const list = (await call('GET /api/marketing/untracked-wins')).body;
const flag = (id) => list.find((w) => w.opportunity_id === id)?.repeat_client;
check('4A a second contract from the same domain is a returning client', flag('006MCL2'), true);
check('4B the first one is not', flag('006MCL1'), false);
check('4C a new organization with no booking is a real gap', flag('006NEW'), false);
check('4D with no domain, the organization name decides', [flag('006NAME1'), flag('006NAME2')], [false, true]);
const s4 = await stats();
check('4E stats split the untracked figures, and the parts add up',
  s4.untracked_repeat_count + s4.untracked_new_count === s4.untracked_count
  && s4.untracked_repeat_revenue + s4.untracked_new_revenue === s4.untracked_revenue, true);

await pool.end();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
