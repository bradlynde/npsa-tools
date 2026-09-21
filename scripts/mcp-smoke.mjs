#!/usr/bin/env node
/*
 * MCP endpoint check.
 *
 * Stands up the MCP layer on a throwaway express app with a handful of fake
 * /api routes standing in for the real ones, so this runs with no database,
 * no Calendly token and no network. It checks the things that matter:
 *
 *   1. The gate. Unset MCP_API_KEYS refuses everything (503, fail closed); a
 *      missing or wrong bearer key is 401; any one of several configured keys
 *      gets in. GET is 405 — there is no session stream to resume.
 *   2. The protocol. A real MCP client (the SDK's own) connects over Streamable
 *      HTTP, lists the tools, and calls them.
 *   3. The plumbing. Tools that go through the loopback /api routes return what
 *      those routes returned; the ones that filter or trim (deadline filtering,
 *      the saved_html omission on letter_get) do so.
 *   4. Writes. Every write tool carries the WRITE annotation and a "confirm"
 *      instruction, forwards the right method and body to the right route, is
 *      logged with the caller's key fingerprint, and disappears entirely for a
 *      key that MCP_WRITE_KEYS leaves out.
 *   5. Grant clients. The nine client/intake tools reach the keyed /api/clients
 *      routes with the internal key and the caller's fingerprint, forward the
 *      right shapes, and surface an unknown-key seed refusal as a tool error.
 *
 *   node scripts/mcp-smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerMcp, MCP_PATH, fingerprint } from '../server/mcp.js';
import { registerGrantKnowledge, createMemoryKnowledgeStore } from '../server/grant-knowledge.js';

const READ_TOOLS = [
  'letters_stats', 'letters_search', 'letter_get', 'reps_list', 'letter_template_get',
  'nsgp_deadlines_list', 'nsgp_state_reference',
  'precall_bookings_list', 'precall_booking_get',
  'marketing_overview', 'marketing_by_campaign', 'marketing_by_channel', 'marketing_timeseries',
  'marketing_bookings', 'marketing_untracked_wins', 'marketing_revenue_quality',
  'clients_list', 'client_get', 'intake_questions', 'intake_answers', 'intake_status', 'intake_uploads_list',
  'gk_overview', 'gk_state_get', 'gk_state_brief', 'gk_requirements', 'gk_search', 'gk_needs_attention', 'gk_files_list', 'gk_revisions',
];
const WRITE_TOOLS = [
  'letter_update', 'rep_add', 'rep_remove',
  'marketing_booking_update', 'marketing_refresh',
  'client_create', 'client_update', 'intake_seed', 'client_token_rotate', 'client_delete',
  'gk_record_upsert', 'gk_mark_verified', 'gk_record_archive', 'gk_revert',
];

const FAKE_STATS = { total: 7, total_fees: 12345, by_rep: [{ rep_name: 'Chad', count: 4 }] };
const FAKE_DEADLINES = {
  deadlines: [
    { id: 1, state: 'IL', program: 'NSGP-S', cycle_year: 2026, deadline: '2026-01-15', kind: 'final' },
    { id: 2, state: 'IL', program: 'NSGP-S', cycle_year: 2027, deadline: '2099-01-15', kind: 'final' },
    { id: 3, state: 'US', program: 'NSGP', cycle_year: 2027, deadline: '2099-02-01', kind: 'federal' },
    { id: 4, state: 'TX', program: 'NSGP-S', cycle_year: 2027, deadline: '2099-03-01', kind: 'final' },
  ],
  reference: { checkedOn: '2026-08-01', notCovered: [], states: { IL: { saa: 'IEMA', saaShort: 'IEMA', lastVerified: '2026-08-01', programs: [] } } },
};
const FAKE_LETTER = { id: 42, client_name: 'Trinity', rep_name: 'Stuart', doc_tab: 'in-house', form_data: { fee: 1 }, saved_html: '<p>big</p>', total_fee: 4500 };

// Every write the fake routes receive, so the checks can see exactly what was sent.
const received = [];
const record = (req, res, body = { ok: true }) => { received.push({ method: req.method, path: req.path, body: req.body }); res.json(body); };

const app = express();
app.use(express.json());
app.get('/api/letters/stats', (_req, res) => res.json(FAKE_STATS));
app.get('/api/letters/:id', (req, res) => req.params.id === '42' ? res.json(FAKE_LETTER) : res.status(404).json({ error: 'Not found' }));
app.put('/api/letters/:id', (req, res) => { Object.assign(FAKE_LETTER, req.body); record(req, res); });
app.post('/api/reps', (req, res) => record(req, res, { id: 5, name: req.body.name }));
app.delete('/api/reps/:id', (req, res) => record(req, res));
app.get('/api/precall/deadlines', (_req, res) => res.json(FAKE_DEADLINES));
app.put('/api/precall/deadlines', (req, res) => record(req, res, { ok: true, id: 9 }));
app.delete('/api/precall/deadlines/:id', (req, res) => record(req, res));
app.patch('/api/marketing/bookings/:id', (req, res) => record(req, res));
app.post('/api/marketing/enrich', (req, res) => record(req, res, { ok: true, refreshed: 3, all: req.query.all === '1' }));
app.get('/api/marketing/stats', (_req, res) => res.status(503).json({ error: 'Storage not configured' }));

// Grant-client routes are keyed; the fakes insist on the internal key the same way.
const INTERNAL = 'boot-secret';
const keyed = (req, res, next) => req.get('x-internal-key') === INTERNAL ? next() : res.status(401).json({ error: 'Unauthorized' });
const FAKE_CLIENT = { id: 1, slug: 'trinity-wellsprings-church', name: 'Trinity Wellsprings Church', state: 'FL', phase: 2, status: 'active', intake_url: 'https://npsa-tools.vercel.app/client/trinity-wellsprings-church?t=abc', contacts: [] };
app.get('/api/clients', keyed, (req, res) => res.json(req.query.status === 'cancelled' ? [] : [{ ...FAKE_CLIENT, actor: req.get('x-actor'), q: req.query }]));
app.post('/api/clients', keyed, (req, res) => record(req, res, { ...FAKE_CLIENT, slug: req.body.slug || 'derived', state: req.body.state }));
app.get('/api/clients/:slug', keyed, (req, res) => req.params.slug === FAKE_CLIENT.slug ? res.json(FAKE_CLIENT) : res.status(404).json({ error: 'No such client' }));
app.patch('/api/clients/:slug', keyed, (req, res) => record(req, res, { ...FAKE_CLIENT, ...req.body }));
app.post('/api/clients/:slug/token', keyed, (req, res) => record(req, res, { ...FAKE_CLIENT, intake_url: 'https://npsa-tools.vercel.app/client/trinity-wellsprings-church?t=new' }));
// Delete answers the way the real route does: nothing happens without confirm=<slug>.
app.delete('/api/clients/:slug', keyed, (req, res) => {
  if (req.query.confirm !== req.params.slug) {
    received.push({ method: 'DELETE', path: req.originalUrl.replace('/api', ''), body: req.body });
    return res.status(400).json({ error: `Nothing was deleted. This would permanently remove ${req.params.slug} with 12 answer(s), 1 upload(s) and 3 contact(s). Call again with confirm="${req.params.slug}" to go ahead.`, confirm_required: req.params.slug });
  }
  received.push({ method: 'DELETE', path: req.originalUrl.replace('/api', ''), body: req.body });
  res.json({ ok: true, deleted: { slug: req.params.slug } });
});
app.get('/api/clients/:slug/answers', keyed, (req, res) => res.json({ slug: req.params.slug, count: 1, q: req.query, answers: [{ key: 'q_1_1_1', value: 'Pat' }] }));
app.put('/api/clients/:slug/answers', keyed, (req, res) => {
  const unknown = Object.keys(req.body.answers || {}).filter(k => k.startsWith('bad_'));
  if (unknown.length) return res.status(400).json({ error: `Unknown intake keys: ${unknown.join(', ')}. Use the question catalog for the exact keys.`, unknown_keys: unknown });
  record(req, res, { ok: true, written: Object.keys(req.body.answers).length });
});
app.get('/api/clients/:slug/status', keyed, (req, res) => res.json({ slug: req.params.slug, core: { answered: 3, total: 130 }, checklist: { completed: 1, total: 24 } }));
app.get('/api/clients/:slug/uploads', keyed, (req, res) => res.json({ slug: req.params.slug, count: 1, uploads: [{ id: 3, key: 'up_501c3', filename: 'irs.pdf', drive_url: null, download_path: `/api/clients/${req.params.slug}/uploads/3` }] }));
app.get('/api/intake/questions', keyed, (req, res) => res.json({ count: 2, q: req.query, questions: [{ key: 'chk_status_kickoff_call' }, { key: 'chk_who_state_reg' }] }));

let port = 0;
// Grant knowledge runs for real, against its in-memory store: the tools resolve
// parents and versions through these routes, so a fake would prove nothing.
const gkStore = createMemoryKnowledgeStore();
registerGrantKnowledge(app, { store: gkStore, internalKey: INTERNAL });
registerMcp(app, { port: () => port, internalKey: INTERNAL });
const httpServer = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
port = httpServer.address().port;
const url = `http://127.0.0.1:${port}${MCP_PATH}`;

const initBody = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
});
const post = (headers = {}) => fetch(url, {
  method: 'POST', body: initBody,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
});

async function connect(key) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  return client;
}
const text = r => JSON.parse(r.content[0].text);
const names = async client => (await client.listTools()).tools.map(t => t.name).sort();

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// ── 1. The gate ───────────────────────────────────────────────────────────────
delete process.env.MCP_API_KEYS;
delete process.env.MCP_API_KEY;
delete process.env.MCP_WRITE_KEYS;
await check('unset MCP_API_KEYS refuses with 503', async () => {
  assert.equal((await post({ Authorization: 'Bearer anything' })).status, 503);
});

process.env.MCP_API_KEYS = 'first-key, second-key';
await check('no bearer key is 401', async () => assert.equal((await post()).status, 401));
await check('wrong bearer key is 401', async () => assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401));
await check('any configured key is accepted', async () => {
  assert.equal((await post({ Authorization: 'Bearer second-key' })).status, 200);
});
await check('GET is 405', async () => {
  const r = await fetch(url, { headers: { Authorization: 'Bearer first-key' } });
  assert.equal(r.status, 405);
});

// ── 2 + 3. Reads through a real client ────────────────────────────────────────
const client = await connect('first-key');

await check('lists every read and write tool when writes are open', async () => {
  assert.deepEqual(await names(client), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const t of (await client.listTools()).tools) assert.ok(t.description?.length > 20, `${t.name} needs a description`);
});

await check('read tools are annotated read-only, write tools are not', async () => {
  for (const t of (await client.listTools()).tools) {
    const isWrite = WRITE_TOOLS.includes(t.name);
    assert.equal(t.annotations?.readOnlyHint, !isWrite, `${t.name} readOnlyHint`);
    if (isWrite) {
      assert.match(t.description, /^WRITE/, `${t.name} must announce itself as a write`);
      assert.match(t.description, /Confirm with the user/, `${t.name} must ask for confirmation`);
    }
  }
  const destructive = (await client.listTools()).tools.filter(t => t.annotations?.destructiveHint).map(t => t.name).sort();
  assert.deepEqual(destructive, ['client_delete', 'client_token_rotate', 'rep_remove']);
});

await check('nsgp_state_reference answers without a database', async () => {
  const r = await client.callTool({ name: 'nsgp_state_reference', arguments: { state: 'il' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const d = text(r);
  assert.equal(d.state, 'IL');
  assert.equal(d.covered, true);
  assert.ok(d.saa, 'SAA name present');
});

await check('letters_stats reads through the loopback route', async () => {
  const r = await client.callTool({ name: 'letters_stats', arguments: {} });
  assert.ok(!r.isError);
  assert.deepEqual(text(r), FAKE_STATS);
});

await check('nsgp_deadlines_list filters to the state plus US, upcoming only', async () => {
  const r = await client.callTool({ name: 'nsgp_deadlines_list', arguments: { state: 'IL', upcoming_only: true } });
  assert.ok(!r.isError);
  const d = text(r);
  assert.deepEqual(d.deadlines.map(x => x.id), [2, 3]);
  assert.equal(d.reference.saa, 'IEMA');
});

await check('letter_get omits saved_html unless asked', async () => {
  const slim = text(await client.callTool({ name: 'letter_get', arguments: { id: 42 } }));
  assert.equal(slim.saved_html, undefined);
  assert.equal(slim.has_saved_html, true);
  const full = text(await client.callTool({ name: 'letter_get', arguments: { id: 42, include_html: true } }));
  assert.equal(full.saved_html, FAKE_LETTER.saved_html);
});

await check('an upstream error becomes a tool error, not a dropped request', async () => {
  const r = await client.callTool({ name: 'letter_get', arguments: { id: 7 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});

await check('a 503 route reports itself as a tool error', async () => {
  const r = await client.callTool({ name: 'marketing_overview', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Storage not configured/);
});

// ── 4. Writes ─────────────────────────────────────────────────────────────────
const lastWrite = () => received[received.length - 1];

await check('the old deadline writes are gone: a deadline is a gk record now', async () => {
  const all = await names(client);
  assert.ok(!all.includes('nsgp_deadline_upsert') && !all.includes('nsgp_deadline_delete'));
  const list = (await client.listTools()).tools.find(t => t.name === 'nsgp_deadlines_list');
  assert.match(list.description, /gk_record_upsert/);
});

await check('letter_update merges only the given fields into the existing record', async () => {
  const r = await client.callTool({ name: 'letter_update', arguments: { id: 42, total_fee: 5000 } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const w = lastWrite();
  assert.equal(w.method, 'PUT');
  assert.equal(w.body.total_fee, 5000);
  assert.equal(w.body.client_name, 'Trinity', 'untouched field carried over');
  assert.deepEqual(w.body.form_data, { fee: 1 }, 'form data carried over');
  assert.equal(w.body.saved_html, '<p>big</p>', 'html carried over');
  assert.equal(text(r).saved_html, undefined, 'response leaves the HTML out');
  assert.equal(text(r).total_fee, 5000);
});

await check('letter_update with nothing to change is a tool error and sends nothing', async () => {
  const before = received.length;
  const r = await client.callTool({ name: 'letter_update', arguments: { id: 42 } });
  assert.equal(r.isError, true);
  assert.equal(received.length, before);
});

await check('rep_add POSTs, rep_remove DELETEs', async () => {
  const a = await client.callTool({ name: 'rep_add', arguments: { name: 'Josh' } });
  assert.deepEqual(text(a), { id: 5, name: 'Josh' });
  assert.deepEqual([lastWrite().method, lastWrite().path, lastWrite().body], ['POST', '/api/reps', { name: 'Josh' }]);
  await client.callTool({ name: 'rep_remove', arguments: { id: 5 } });
  assert.deepEqual([lastWrite().method, lastWrite().path], ['DELETE', '/api/reps/5']);
});

await check('marketing_booking_update PATCHes only the fields given', async () => {
  const r = await client.callTool({ name: 'marketing_booking_update', arguments: { id: 17, held: true, exclusion: '' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const w = lastWrite();
  assert.deepEqual([w.method, w.path], ['PATCH', '/api/marketing/bookings/17']);
  assert.deepEqual(w.body, { held: true, exclusion: '' });
  const empty = await client.callTool({ name: 'marketing_booking_update', arguments: { id: 17 } });
  assert.equal(empty.isError, true);
  const before = received.length;
  const typo = await client.callTool({ name: 'marketing_booking_update', arguments: { id: 17, exclusion: 'typo' } });
  assert.equal(typo.isError, true);
  assert.match(typo.content[0].text, /Invalid arguments/);
  assert.equal(received.length, before, 'a bad exclusion reason never reaches the route');
});

await check('marketing_refresh POSTs, with all=1 only when asked', async () => {
  const stale = text(await client.callTool({ name: 'marketing_refresh', arguments: {} }));
  assert.equal(stale.all, false);
  const full = text(await client.callTool({ name: 'marketing_refresh', arguments: { all: true } }));
  assert.equal(full.all, true);
});

await check('every write is logged with the caller\'s key fingerprint', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await client.callTool({ name: 'rep_add', arguments: { name: 'Audit' } }); }
  finally { console.log = orig; }
  const line = lines.find(l => l.startsWith('[mcp] write rep_add by '));
  assert.ok(line, 'audit line present');
  assert.match(line, /by [0-9a-f]{8} /, 'fingerprint, not the key');
  assert.ok(!line.includes('first-key'), 'the key itself never appears');
});

await check('MCP_KEY_NAMES puts a name on the audit line and on X-Actor', async () => {
  process.env.MCP_KEY_NAMES = `${fingerprint('first-key')}:Stuart`;
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await client.callTool({ name: 'rep_add', arguments: { name: 'Audit' } });
    const d = text(await client.callTool({ name: 'clients_list', arguments: { status: 'all' } }));
    assert.equal(d.clients[0].actor, 'Stuart');
  } finally { console.log = orig; delete process.env.MCP_KEY_NAMES; }
  assert.ok(lines.some(l => l.startsWith('[mcp] write rep_add by Stuart ')), 'audit line names the person');
});

// ── 5. Grant clients ──────────────────────────────────────────────────────────
await check('clients_list reaches the keyed route with the internal key and the caller fingerprint', async () => {
  const r = await client.callTool({ name: 'clients_list', arguments: { status: 'all', search: 'trin' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const d = text(r);
  assert.equal(d.count, 1);
  assert.equal(d.clients[0].slug, 'trinity-wellsprings-church');
  assert.match(d.clients[0].actor, /^[0-9a-f]{8}$/, 'X-Actor is the key fingerprint');
  assert.deepEqual(d.clients[0].q, { status: 'all', search: 'trin' });
  const none = text(await client.callTool({ name: 'clients_list', arguments: { status: 'cancelled' } }));
  assert.equal(none.count, 0);
});

await check('client_get, intake_status, intake_answers and intake_questions forward their filters', async () => {
  assert.equal(text(await client.callTool({ name: 'client_get', arguments: { slug: 'trinity-wellsprings-church' } })).name, 'Trinity Wellsprings Church');
  const missing = await client.callTool({ name: 'client_get', arguments: { slug: 'nobody' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No such client/);
  assert.equal(text(await client.callTool({ name: 'intake_status', arguments: { slug: 'trinity-wellsprings-church' } })).checklist.total, 24);
  const up = text(await client.callTool({ name: 'intake_uploads_list', arguments: { slug: 'trinity-wellsprings-church' } }));
  assert.equal(up.uploads[0].filename, 'irs.pdf');
  assert.match(up.uploads[0].download_path, /\/uploads\/3$/);
  const a = text(await client.callTool({ name: 'intake_answers', arguments: { slug: 'trinity-wellsprings-church', section: '4. Threats', include_empty: true } }));
  assert.deepEqual(a.q, { section: '4. Threats', include_empty: '1' });
  const q = text(await client.callTool({ name: 'intake_questions', arguments: { prefix: 'chk_' } }));
  assert.deepEqual(q.q, { prefix: 'chk_' });
});

await check('client_create POSTs with the state normalised', async () => {
  const r = await client.callTool({ name: 'client_create', arguments: {
    name: 'Trinity Wellsprings Church', state: 'fl', kickoff_date: '2026-09-08', upload_folder_id: 'PHASE2',
    contacts: [{ name: 'Pat Lee', email: 'pat@trinity.org', role: 'Executive Pastor', phone: '(555) 555-1212' }],
    npsa_contacts: [{ name: 'Jeff Markley', email: 'jeff@nonprofitsecurityadvisors.com', role: 'Sales rep' }],
  } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const w = lastWrite();
  assert.deepEqual([w.method, w.path], ['POST', '/api/clients']);
  assert.equal(w.body.state, 'FL');
  assert.equal(w.body.contacts[0].email, 'pat@trinity.org');
  assert.equal(w.body.contacts[0].phone, '(555) 555-1212');
  assert.equal(w.body.npsa_contacts[0].role, 'Sales rep');
  assert.equal(w.body.upload_folder_id, 'PHASE2');
  assert.match(text(r).intake_url, /^https:\/\/npsa-tools\.vercel\.app\/client\//);
  const bad = await client.callTool({ name: 'client_create', arguments: { name: 'X', state: 'FL', kickoff_date: '9/8/2026' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Invalid arguments/);
});

await check('client_update PATCHes only the fields given and refuses an empty change', async () => {
  const r = await client.callTool({ name: 'client_update', arguments: { slug: 'trinity-wellsprings-church', status: 'submitted', add_contacts: [{ email: 'sam@trinity.org' }] } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const w = lastWrite();
  assert.deepEqual([w.method, w.path], ['PATCH', '/api/clients/trinity-wellsprings-church']);
  assert.deepEqual(w.body, { status: 'submitted', add_contacts: [{ email: 'sam@trinity.org' }] });
  const empty = await client.callTool({ name: 'client_update', arguments: { slug: 'trinity-wellsprings-church' } });
  assert.equal(empty.isError, true);
  const before = received.length;
  const typo = await client.callTool({ name: 'client_update', arguments: { slug: 'trinity-wellsprings-church', status: 'done' } });
  assert.equal(typo.isError, true);
  assert.equal(received.length, before, 'a bad status never reaches the route');
});

await check('intake_seed PUTs the answers and surfaces an unknown-key refusal by name', async () => {
  const ok = await client.callTool({ name: 'intake_seed', arguments: { slug: 'trinity-wellsprings-church', answers: { q_1_1_1: 'Pat Lee', q_1_3_7: 12, chk_status_kickoff_call: 'Completed' } } });
  assert.ok(!ok.isError, ok.content?.[0]?.text);
  assert.equal(text(ok).written, 3);
  const w = lastWrite();
  assert.deepEqual([w.method, w.path], ['PUT', '/api/clients/trinity-wellsprings-church/answers']);
  assert.equal(w.body.answers.q_1_3_7, 12);
  assert.equal(w.body.by, undefined);
  const bad = await client.callTool({ name: 'intake_seed', arguments: { slug: 'trinity-wellsprings-church', answers: { q_1_1_1: 'x', bad_key: 'y' } } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Unknown intake keys: bad_key/);
  const empty = await client.callTool({ name: 'intake_seed', arguments: { slug: 'trinity-wellsprings-church', answers: {} } });
  assert.equal(empty.isError, true);
});

await check('client_delete asks before it commits, then deletes', async () => {
  const first = await client.callTool({ name: 'client_delete', arguments: { slug: 'trinity-wellsprings-church' } });
  assert.match(JSON.stringify(first), /Nothing was deleted|active client/i);
  const sent = received.filter((c) => c.method === 'DELETE' && /clients\//.test(c.path || ''));
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].path.includes('confirm='), 'the first call carries no confirmation');
  const second = await client.callTool({ name: 'client_delete', arguments: { slug: 'trinity-wellsprings-church', confirm: 'trinity-wellsprings-church' } });
  assert.ok(!second.isError, second.content?.[0]?.text);
  assert.ok(received.some((c) => c.method === 'DELETE' && (c.path || '').includes('confirm=trinity-wellsprings-church')));
});
await check('client_token_rotate POSTs and returns the new link', async () => {
  const r = await client.callTool({ name: 'client_token_rotate', arguments: { slug: 'trinity-wellsprings-church' } });
  assert.ok(!r.isError);
  assert.deepEqual([lastWrite().method, lastWrite().path], ['POST', '/api/clients/trinity-wellsprings-church/token']);
  assert.match(text(r).intake_url, /t=new$/);
});

// ── 6. Grant knowledge ────────────────────────────────────────────────────────
const gk = async (name, args) => client.callTool({ name, arguments: args });
await check('gk_record_upsert builds a state top down, resolving each parent by key', async () => {
  const src = 'https://egrants.gov.texas.gov/fundingopp';
  const j = text(await gk('gk_record_upsert', { state: 'tx', kind: 'jurisdiction', data: { saa: 'Office of the Governor, Public Safety Office', saa_short: 'OOG PSO', default_tz: 'America/Chicago' }, source_url: src }));
  assert.equal(j.key, 'TX'); assert.equal(j.status, 'unverified'); assert.equal(j.version, 1);
  const p = text(await gk('gk_record_upsert', { state: 'TX', kind: 'program', key: 'NSGP-S', data: { name: 'NSGP State', type: 'federal' }, source_url: src, origin: 'research' }));
  assert.equal(p.kind, 'program');
  assert.equal(gkStore._records.find(r => r.id === p.id).origin, 'research');
  await gk('gk_record_upsert', { state: 'TX', kind: 'requirement', program: 'nsgp-s', data: { req_type: 'registration', label: 'eGrants account', owner: 'client', hard_gate: true, lead_time_days: 60 }, source_url: src });
  await gk('gk_record_upsert', { state: 'TX', kind: 'cycle', program: 'NSGP-S', data: { fiscal_year: 2027, open_date: '2027-01-12' }, source_url: src });
  const d = text(await gk('gk_record_upsert', { state: 'TX', kind: 'deadline', program: 'NSGP-S', cycle: '2027', data: { label: 'Stage 1: certify', due_date: '2027-03-12', due_time: '17:00' }, source_url: src }));
  assert.equal(d.kind, 'deadline');
  assert.equal(gkStore._revisions.at(-1).actor_kind, 'mcp');
  assert.match(gkStore._revisions.at(-1).actor, /^[0-9a-f]{8}$/, 'the caller, as the loopback names it');
});
await check('gk_record_upsert refuses a write with no source or reason, a missing parent, and an edit with no version', async () => {
  const bare = await gk('gk_record_upsert', { state: 'TX', kind: 'note', data: { category: 'gotcha', title: 'x' } });
  assert.ok(bare.isError); assert.match(bare.content[0].text, /source_url, or a reason/);
  const orphan = await gk('gk_record_upsert', { state: 'TX', kind: 'deadline', program: 'NSGP-S', cycle: '2031', data: { label: 'x', due_date: '2031-01-01' }, reason: 'user said so' });
  assert.ok(orphan.isError); assert.match(orphan.content[0].text, /no cycle "2031"\. It has: 2027/);
  const noProgram = await gk('gk_record_upsert', { state: 'TX', kind: 'cycle', data: { fiscal_year: 2028 }, reason: 'user said so' });
  assert.match(noProgram.content[0].text, /pass program\. TX has: NSGP-S/);
  const again = await gk('gk_record_upsert', { state: 'TX', kind: 'program', key: 'nsgp-s', data: { ma_pct: 5 }, reason: 'user said so' });
  assert.ok(again.isError); assert.match(again.content[0].text, /already exists at version 1\. Pass version: 1/);
  const typo = await gk('gk_record_upsert', { state: 'TX', kind: 'program', key: 'NSGP-S', version: 1, data: { cap_per_site: 1 }, reason: 'user said so' });
  assert.match(typo.content[0].text, /unknown field\(s\) cap_per_site/);
  const ok = text(await gk('gk_record_upsert', { state: 'TX', kind: 'program', key: 'NSGP-S', version: 1, data: { ma_pct: 5 }, reason: 'user said so from the FY26 engagement' }));
  assert.equal(ok.version, 2); assert.equal(ok.data.ma_pct, 5);
  const stale = await gk('gk_record_upsert', { state: 'TX', kind: 'program', key: 'NSGP-S', version: 1, data: { ma_pct: 4 }, reason: 'x' });
  assert.ok(stale.isError); assert.match(stale.content[0].text, /changed while you were editing/);
});
await check('the gk reads: overview filters, state_get sections, the brief, the checklist, search, attention, history', async () => {
  const o = text(await gk('gk_overview', { cycle_state: 'soon' }));
  assert.equal(o.count, 1); assert.equal(o.jurisdictions[0].code, 'TX');
  assert.equal(text(await gk('gk_overview', {})).count, 57);
  const s = text(await gk('gk_state_get', { state: 'tx', sections: ['programs'] }));
  assert.equal(s.programs[0].cycles[0].deadlines[0].data.due_time, '17:00'); assert.equal(s.contacts, undefined);
  assert.ok(s.programs[0].version && s.programs[0].id, 'id and version to write back with');
  const brief = (await gk('gk_state_brief', { state: 'TX' })).content[0].text;
  assert.match(brief, /^# Texas \(TX\)/); assert.match(brief, /\*\*HARD GATE\*\* eGrants account \[client, allow 60 days\] _\(unverified\)_/); assert.match(brief, /Stage 1: certify: 2027-03-12 17:00/);
  const req = text(await gk('gk_requirements', { state: 'TX', program: 'NSGP-S' }));
  assert.equal(req.programs[0].registration[0].hard_gate, true);
  assert.equal(text(await gk('gk_search', { query: 'egrants', kinds: ['requirement'] })).hits.length, 1);
  const a = text(await gk('gk_needs_attention', { state: 'TX', days: 365 }));
  assert.equal(a.counts.deadlines_soon, 1); assert.ok(a.counts.unverified >= 5);
  const h = text(await gk('gk_revisions', { state: 'TX', limit: 3 }));
  assert.equal(h.revisions.length, 3); assert.equal(h.revisions[0].action, 'update');
  // Files are put there from the toolbox, so a state with none reads as none, and
  // what does come back never carries a download link only a browser could use.
  const f = text(await gk('gk_files_list', { state: 'TX' }));
  assert.deepEqual(f.files, []);
  assert.ok(!JSON.stringify(f).includes('download_url'));
});
await check('verify, archive, restore and revert go through, each as a revision', async () => {
  const p = text(await gk('gk_state_get', { state: 'TX', sections: ['programs'] })).programs[0];
  const v = text(await gk('gk_mark_verified', { record_id: p.id, version: p.version }));
  assert.equal(v.status, 'verified');
  const a = text(await gk('gk_record_archive', { record_id: p.id, version: v.version, reason: 'test' }));
  assert.equal(text(await gk('gk_state_get', { state: 'TX' })).programs.length, 0);
  const r = text(await gk('gk_record_archive', { record_id: p.id, version: a.version, restore: true }));
  const rev = text(await gk('gk_revisions', { record_id: p.id })).revisions.find(x => x.action === 'update');
  const back = text(await gk('gk_revert', { revision_id: rev.id, version: r.version }));
  assert.equal(back.data.ma_pct, undefined, 'the 5% edit is undone');
  assert.deepEqual(text(await gk('gk_revisions', { record_id: p.id })).revisions.map(x => x.action), ['revert', 'restore', 'archive', 'verify', 'update', 'create']);
});
await check('nsgp_state_reference reads the knowledge base once it has states, and says so', async () => {
  await gk('gk_record_upsert', { state: 'NJ', kind: 'jurisdiction', data: { saa: 'NJ Office of Homeland Security & Preparedness', saa_short: 'NJOHSP' }, reason: 'user said so' });
  await gk('gk_record_upsert', { state: 'NJ', kind: 'program', key: 'NJ-NSGP-THE', data: { name: 'NJ NSGP Target Hardening', type: 'state', cap_per_applicant: 100000, stackable: true, exclusive_with: ['NJ-NSGP-SP'] }, reason: 'user said so' });
  const nj = text(await gk('nsgp_state_reference', { state: 'nj' }));
  assert.equal(nj.source, 'knowledge-base'); assert.equal(nj.saaShort, 'NJOHSP');
  assert.deepEqual(nj.programs[0], { acronym: 'NJ-NSGP-THE', name: 'NJ NSGP Target Hardening', perSite: null, perApplicant: 100000, stackable: true, note: '', exclusiveWith: ['NJ-NSGP-THE', 'NJ-NSGP-SP'] });
  const all = text(await gk('nsgp_state_reference', {}));
  assert.deepEqual(Object.keys(all.states).sort(), ['NJ', 'TX']); assert.ok(all.not_covered.includes('GU'));
});

await client.close();

// ── MCP_WRITE_KEYS narrows who can write ──────────────────────────────────────
process.env.MCP_WRITE_KEYS = 'first-key';
const reader = await connect('second-key');
const writer = await connect('first-key');

await check('a key outside MCP_WRITE_KEYS sees only the read tools', async () => {
  assert.deepEqual(await names(reader), [...READ_TOOLS].sort());
});

await check('a key outside MCP_WRITE_KEYS cannot call a write tool', async () => {
  const before = received.length;
  const r = await reader.callTool({ name: 'rep_add', arguments: { name: 'Nope' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found/);
  assert.equal(received.length, before, 'nothing was sent');
});

await check('a key on MCP_WRITE_KEYS still has everything', async () => {
  assert.deepEqual(await names(writer), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

await reader.close();
await writer.close();
httpServer.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nAll MCP checks passed');
process.exit(failures ? 1 : 0);
