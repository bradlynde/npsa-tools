#!/usr/bin/env node
/*
 * /api gate check.
 *
 * The Sales Toolbox routes were written with no auth of their own and sat open on
 * the public Railway URL. server/api-gate.js now stands in front of all of /api.
 * This mounts the gate on a throwaway app, the way index.js does, with fake routes
 * behind it, and checks:
 *
 *   1. A toolbox route refuses a caller with nothing, a wrong key, a forged or
 *      expired login token, and a login token when JWT_SECRET is unset.
 *   2. It admits the internal key, an MCP_API_KEYS key, and a login token signed
 *      with JWT_SECRET, and records who the caller is.
 *   3. The self-gated modules (clients, intake, grant knowledge) pass straight
 *      through to their own gates, so the client intake page keeps working.
 *   4. The Zapier routes want the Zapier secret, compared exactly, and refuse
 *      everything when ZAPIER_WEBHOOK_SECRET is unset. A team key does not open them.
 *   5. The gate runs before body parsing: a large unauthenticated body is a 401.
 *   6. The welcome email: a random MIME boundary per message, and an "added by"
 *      name with line breaks cannot open a part of its own.
 *
 *   node scripts/api-gate-smoke.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { apiGate, verifyJwt } from '../server/api-gate.js';
import { buildRaw, welcomeMessage, oneLine } from '../server/mail.js';

const INTERNAL = 'internal-key-for-this-process';
const SECRET = 'jwt-secret-shared-with-the-auth-service';
const ZAP = 'zap-secret-value';

function jwt(claims, secret = SECRET) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const app = express();
app.use('/api', apiGate({ internalKey: INTERNAL }));
app.use(express.json({ limit: '50mb' }));
const echo = (req, res) => res.json({ ok: true, actor: req.actor || null, kind: req.actorKind || null });
app.get('/api/letters', echo);
app.post('/api/letters', echo);
app.get('/api/marketing/bookings', echo);
app.post('/api/marketing/wins/reconcile', echo);
app.post('/api/marketing/sync/push', echo);
app.get('/api/clients', (req, res) => res.status(401).json({ error: 'the intake module decides' }));
app.put('/api/intake/some-church/answers', (req, res) => res.json({ reached: 'intake' }));
app.post('/api/grant-knowledge/files/upload', (req, res) => res.json({ reached: 'grant-knowledge' }));

const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  let data = null; try { data = await r.json(); } catch { /* not json */ }
  return { status: r.status, data };
};
const bearer = t => ({ Authorization: `Bearer ${t}` });

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

process.env.MCP_API_KEYS = 'team-key-one, team-key-two';
process.env.JWT_SECRET = SECRET;
process.env.ZAPIER_WEBHOOK_SECRET = ZAP;

// ── 1. Refusals ───────────────────────────────────────────────────────────────
await check('a toolbox route refuses a caller with no credential', async () => {
  const r = await call('GET', '/api/letters');
  assert.equal(r.status, 401);
  assert.equal((await call('GET', '/api/marketing/bookings')).status, 401);
  assert.equal((await call('POST', '/api/letters', {}, { client_name: 'x' })).status, 401);
});

await check('a wrong key, a wrong internal key and a Zapier secret do not open a toolbox route', async () => {
  assert.equal((await call('GET', '/api/letters', bearer('not-a-key'))).status, 401);
  assert.equal((await call('GET', '/api/letters', { 'X-Internal-Key': 'guess' })).status, 401);
  assert.equal((await call('GET', '/api/letters', { 'X-Zap-Secret': ZAP })).status, 401);
});

await check('a login token signed with the wrong secret, expired, or malformed is refused', async () => {
  assert.equal((await call('GET', '/api/letters', bearer(jwt({ username: 'stuart', exp: inAnHour() }, 'other-secret')))).status, 401);
  assert.equal((await call('GET', '/api/letters', bearer(jwt({ username: 'stuart', exp: 1 })))).status, 401);
  assert.equal((await call('GET', '/api/letters', bearer('a.b'))).status, 401);
  const [h, p] = jwt({ username: 'stuart', exp: inAnHour() }).split('.');
  const forged = Buffer.from(JSON.stringify({ username: 'brad', exp: inAnHour() })).toString('base64url');
  assert.equal((await call('GET', '/api/letters', bearer(`${h}.${forged}.${jwt({ username: 'stuart', exp: inAnHour() }).split('.')[2]}`))).status, 401, 'payload swapped under a real signature');
  assert.ok(p);
});

await check('with JWT_SECRET unset, no login token gets in, however well-formed', async () => {
  delete process.env.JWT_SECRET;
  try {
    assert.equal(verifyJwt(jwt({ username: 'stuart', exp: inAnHour() }), undefined).ok, false);
    assert.equal((await call('GET', '/api/letters', bearer(jwt({ username: 'stuart', exp: inAnHour() })))).status, 401);
  } finally { process.env.JWT_SECRET = SECRET; }
});

// ── 2. Admissions ─────────────────────────────────────────────────────────────
await check('the internal key gets in, named by X-Actor', async () => {
  const r = await call('GET', '/api/letters', { 'X-Internal-Key': INTERNAL, 'X-Actor': 'mcp:stuart' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.actor, r.data.kind], ['mcp:stuart', 'mcp']);
});

await check('any MCP_API_KEYS key gets in, named for itself', async () => {
  const r = await call('GET', '/api/marketing/bookings', bearer('team-key-two'));
  assert.equal(r.status, 200);
  assert.equal(r.data.kind, 'key');
  assert.match(r.data.actor, /^[0-9a-f]{8}$/, 'fingerprint, not the key');
});

await check('a key not on ACTOR_PROXY_KEYS cannot claim to be someone else', async () => {
  const r = await call('GET', '/api/letters', { ...bearer('team-key-one'), 'X-Actor': 'brad' });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.actor, 'brad');
});

await check('a login token signed with JWT_SECRET gets in as that person', async () => {
  const r = await call('POST', '/api/letters', bearer(jwt({ username: 'stuart', exp: inAnHour() })), { client_name: 'x' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.actor, r.data.kind], ['stuart', 'user']);
});

// ── 3. Self-gated modules ─────────────────────────────────────────────────────
await check('clients, intake and grant knowledge routes reach their own gates untouched', async () => {
  assert.deepEqual((await call('GET', '/api/clients')).data, { error: 'the intake module decides' });
  assert.deepEqual((await call('PUT', '/api/intake/some-church/answers', {}, { answers: {} })).data, { reached: 'intake' });
  assert.deepEqual((await call('POST', '/api/grant-knowledge/files/upload')).data, { reached: 'grant-knowledge' });
});

// ── 4. Zapier routes ──────────────────────────────────────────────────────────
await check('a Zapier route takes the exact Zapier secret and nothing else', async () => {
  assert.equal((await call('POST', '/api/marketing/wins/reconcile', {}, { opportunity_ids: ['x'] })).status, 401);
  assert.equal((await call('POST', '/api/marketing/wins/reconcile', { 'X-Zap-Secret': `${ZAP}x` }, {})).status, 401);
  assert.equal((await call('POST', '/api/marketing/wins/reconcile', bearer('team-key-one'), {})).status, 401, 'a team key is not a Zapier secret');
  const ok = await call('POST', '/api/marketing/sync/push', { 'X-Zap-Secret': ZAP }, { source: 'salesforce_wins', records: [] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.actor, 'zapier');
});

await check('with ZAPIER_WEBHOOK_SECRET unset the Zapier routes refuse everything', async () => {
  delete process.env.ZAPIER_WEBHOOK_SECRET;
  try {
    const r = await call('POST', '/api/marketing/wins/reconcile', { 'X-Zap-Secret': '' }, { opportunity_ids: ['x'] });
    assert.equal(r.status, 503);
    assert.equal((await call('POST', '/api/marketing/wins/reconcile', { 'X-Zap-Secret': 'anything' }, {})).status, 503);
  } finally { process.env.ZAPIER_WEBHOOK_SECRET = ZAP; }
});

// ── 5. Before the body ────────────────────────────────────────────────────────
await check('an unauthenticated request is refused before its body is parsed', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(20 * 1024 * 1024) });
  const r = await call('POST', '/api/letters', {}, big);
  assert.equal(r.status, 401);
});

// ── 6. The welcome email ──────────────────────────────────────────────────────
await check('each message gets its own random MIME boundary', async () => {
  const a = buildRaw({ from: 'a@x', to: 'b@x', subject: 's', text: 't', html: 'h' });
  const b = buildRaw({ from: 'a@x', to: 'b@x', subject: 's', text: 't', html: 'h' });
  const boundary = raw => /boundary="([^"]+)"/.exec(raw)[1];
  assert.notEqual(boundary(a), boundary(b));
  assert.match(boundary(a), /^npsa-[0-9a-f]{32}$/);
  assert.ok(!a.includes('npsa-welcome-boundary'));
});

await check('an "added by" name with line breaks stays on one line of the body', async () => {
  const evil = 'Pat\r\n\r\n--npsa-welcome-boundary\r\nContent-Type: text/html\r\n\r\n<a href="https://evil.example">Reset your password</a>';
  const m = welcomeMessage({
    client: { name: 'Trinity' }, contact: { name: 'Lee\r\nPark' }, addedBy: evil,
    sender: { name: 'Stuart', role: 'Director of Grants' }, intakeUrl: 'https://npsa-tools.vercel.app/client/trinity?t=x',
  });
  const line = m.text.split('\n').find(l => l.includes('added you to'));
  assert.ok(line, 'the added-by line is present');
  assert.ok(!/[\r\n]/.test(oneLine(evil)));
  assert.ok(oneLine(evil).length <= 80);
  assert.ok(!m.text.includes('\r'), 'no carriage returns in the body');
  assert.ok(!m.text.split('\n').some(l => l.startsWith('--npsa') || l.startsWith('Content-Type')), 'nothing that reads as a MIME line');
  const raw = buildRaw({ from: 'a@x', to: 'b@x', subject: m.subject, text: m.text, html: m.html });
  const b = /boundary="([^"]+)"/.exec(raw)[1];
  assert.equal(raw.split(`--${b}`).length - 1, 3, 'exactly two parts and a close');
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll API gate checks passed');
process.exit(failures ? 1 : 0);
