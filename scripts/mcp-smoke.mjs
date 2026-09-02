#!/usr/bin/env node
/*
 * MCP endpoint check.
 *
 * Stands up the MCP layer on a throwaway express app with a handful of fake
 * /api routes standing in for the real ones, so this runs with no database,
 * no Calendly token and no network. It checks the three things that matter:
 *
 *   1. The gate. Unset MCP_API_KEYS refuses everything (503, fail closed); a
 *      missing or wrong bearer key is 401; any one of several configured keys
 *      gets in. GET is 405 — there is no session stream to resume.
 *   2. The protocol. A real MCP client (the SDK's own) connects over Streamable
 *      HTTP, lists the tools, and calls them.
 *   3. The plumbing. Tools that go through the loopback /api routes return what
 *      those routes returned; the ones that filter or trim (deadline filtering,
 *      the saved_html omission on letter_get) do so.
 *
 *   node scripts/mcp-smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerMcp, MCP_PATH } from '../server/mcp.js';

const EXPECTED_TOOLS = [
  'letters_stats', 'letters_search', 'letter_get', 'reps_list', 'letter_template_get',
  'nsgp_deadlines_list', 'nsgp_state_reference',
  'precall_bookings_list', 'precall_booking_get',
  'marketing_overview', 'marketing_by_campaign', 'marketing_by_channel', 'marketing_timeseries',
  'marketing_bookings', 'marketing_untracked_wins', 'marketing_revenue_quality',
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

const app = express();
app.use(express.json());
app.get('/api/letters/stats', (_req, res) => res.json(FAKE_STATS));
app.get('/api/letters/:id', (req, res) => req.params.id === '42' ? res.json(FAKE_LETTER) : res.status(404).json({ error: 'Not found' }));
app.get('/api/precall/deadlines', (_req, res) => res.json(FAKE_DEADLINES));
app.get('/api/marketing/stats', (_req, res) => res.status(503).json({ error: 'Storage not configured' }));

let port = 0;
registerMcp(app, { port: () => port });
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

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// ── 1. The gate ───────────────────────────────────────────────────────────────
delete process.env.MCP_API_KEYS;
delete process.env.MCP_API_KEY;
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

// ── 2 + 3. A real client ──────────────────────────────────────────────────────
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: 'Bearer first-key' } },
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const text = r => JSON.parse(r.content[0].text);

await check('lists every tool', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of tools) assert.ok(t.description?.length > 20, `${t.name} needs a description`);
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

await client.close();
httpServer.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nAll MCP checks passed');
process.exit(failures ? 1 : 0);
