#!/usr/bin/env node
/*
 * OAuth sign-in check for /mcp.
 *
 * No network, no database. Stands up a fake auth service on a local port (request-code
 * always ok; verify-code signs a login token with a test JWT_SECRET for code 123456,
 * 401 otherwise, 429 for 999999) and an app laid out like index.js: express.static,
 * the /api gate, the OAuth module on its in-memory store, registerMcp, and an SPA
 * fallback last. Then it walks the flow the way ChatGPT and claude.ai do:
 *
 *   1. Metadata. The authorization-server document and the protected-resource
 *      document at both /.well-known/oauth-protected-resource/mcp and the bare path,
 *      with resource equal to the /mcp URL; nothing shadowed by static or the SPA.
 *   2. Registration. chatgpt.com, claude.ai and a loopback port are accepted;
 *      another host, a lookalike host, and plain http off loopback are refused.
 *   3. The sign-in page. Renders with the client's name escaped, the redirect host,
 *      and no-store, DENY, and a nonce CSP with frame-ancestors 'none'.
 *   4. The code steps. request-code is proxied; a wrong code is 401 and issues
 *      nothing, the pending sign-in stays usable; 429 passes through; a token the
 *      secret does not verify issues nothing; the right code redirects with code
 *      and state; the pending sign-in is then spent.
 *   5. The token endpoint. PKCE enforced, a code works once (and a second use
 *      withdraws what it bought), redirect_uri and resource must match, codes expire.
 *   6. /mcp. An access token lists and calls tools as the person: the MCP audit
 *      line and the X-Actor loopback name them. Refresh rotates and the old refresh
 *      is refused; revoke and expiry end a token; a token for another resource is
 *      refused; no token is 401 pointing at the resource metadata. Keys still work,
 *      and MCP_WRITE_KEYS narrows keys only.
 *   7. Unconfigured. With AUTH_API_URL unset nothing is mounted and /mcp is keys
 *      only, as before (401 without resource_metadata, 503 with no keys).
 *   8. The SDK's own client OAuth helper, end to end.
 *
 *   node scripts/oauth-smoke.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { registerMcp, MCP_PATH, fingerprint } from '../server/mcp.js';
import { apiGate } from '../server/api-gate.js';
import { registerOAuth, createMemoryOAuthStore, sha256 } from '../server/oauth.js';

const SECRET = 'test-jwt-secret-for-the-smoke';
const INTERNAL = 'internal-key-for-this-process';
const TEAM_KEY = 'team-key-for-the-smoke';

const listen = app => new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
function jwt(claims, secret = SECRET) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

// ── Fake auth service ─────────────────────────────────────────────────────────
const codeRequests = [];
const auth = express();
auth.use(express.json());
auth.post('/auth/request-code', (req, res) => { codeRequests.push(req.body.email); res.json({ status: 'ok' }); });
auth.post('/auth/verify-code', (req, res) => {
  const { email, code } = req.body || {};
  if (code === '999999') return res.status(429).json({ detail: 'Too many requests from this address' });
  if (code !== '123456') return res.status(401).json({ detail: 'Invalid or expired code' });
  const username = email.startsWith('stuart') ? 'stuart' : email.split('@')[0];
  const secret = email.startsWith('forged') ? 'some-other-secret' : SECRET;
  res.json({ status: 'ok', token: jwt({ username, exp: Math.floor(Date.now() / 1000) + 3600 }, secret), username });
});
const authServer = await listen(auth);
const AUTH_API_URL = `http://127.0.0.1:${authServer.address().port}`;

// ── The app, laid out like index.js ──────────────────────────────────────────
const app = express();
const httpServer = await listen(app);
const port = httpServer.address().port;
const BASE = `http://127.0.0.1:${port}`;
const MCP_URL = `${BASE}${MCP_PATH}`;
const PRM_URL = `${BASE}/.well-known/oauth-protected-resource/mcp`;

process.env.AUTH_API_URL = AUTH_API_URL;
process.env.JWT_SECRET = SECRET;
process.env.MCP_PUBLIC_URL = BASE;
process.env.MCP_API_KEYS = TEAM_KEY;
delete process.env.MCP_WRITE_KEYS;
delete process.env.OAUTH_REDIRECT_HOSTS;

let clock = Date.now();
const now = () => clock;
const oauthLog = [];
const store = createMemoryOAuthStore();
let codesIssued = 0;
const countingStore = { ...store, addCode: async c => { codesIssued++; return store.addCode(c); } };

// What reached the loopback /api routes, with who the gate said was calling.
const received = [];
app.use('/api', apiGate({ internalKey: INTERNAL }));
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
app.get('/api/letters/stats', (req, res) => res.json({ total: 1, actor: req.actor }));
app.post('/api/reps', (req, res) => { received.push({ actor: req.actor, xActor: req.get('x-actor'), body: req.body }); res.json({ id: 9, name: req.body.name }); });
const oauth = registerOAuth(app, { store: countingStore, now, log: l => oauthLog.push(l) });
registerMcp(app, { port: () => port, internalKey: INTERNAL, oauth });
app.use('/api', (req, res) => res.status(404).json({ error: 'No such API route' }));
app.get('*', (_req, res) => res.type('html').send('<!doctype html><title>SPA</title>'));

// The MCP audit lines go to console.log; keep them for the checks.
const mcpLog = [];
const realLog = console.log;
console.log = (...a) => { const l = a.join(' '); if (l.startsWith('[mcp]')) mcpLog.push(l); else realLog(...a); };

let failures = 0;
async function check(name, fn) {
  try { await fn(); realLog(`PASS  ${name}`); }
  catch (err) { failures++; realLog(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ') || err.message}`); }
}

const getJson = async path => { const r = await fetch(`${BASE}${path}`); return { status: r.status, type: r.headers.get('content-type') || '', data: await r.json().catch(() => null) }; };
const postJson = async (path, body, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
};
const postForm = async (path, fields) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
const mcpPost = (headers = {}) => fetch(MCP_URL, { method: 'POST', body: initBody, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } });
async function connect(token) {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

// ── 1. Metadata ───────────────────────────────────────────────────────────────
await check('authorization-server metadata is served with the configured issuer', async () => {
  const r = await getJson('/.well-known/oauth-authorization-server');
  assert.equal(r.status, 200);
  assert.match(r.type, /json/);
  assert.equal(r.data.issuer, `${BASE}/`);
  assert.equal(r.data.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(r.data.token_endpoint, `${BASE}/token`);
  assert.equal(r.data.registration_endpoint, `${BASE}/register`);
  assert.equal(r.data.revocation_endpoint, `${BASE}/revoke`);
  assert.deepEqual(r.data.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(r.data.scopes_supported, ['mcp']);
});
await check('protected-resource metadata at /.well-known/oauth-protected-resource/mcp and the bare path', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const r = await getJson(path);
    assert.equal(r.status, 200, path);
    assert.match(r.type, /json/, `${path} is JSON, not the SPA`);
    assert.equal(r.data.resource, MCP_URL, path);
    assert.deepEqual(r.data.authorization_servers, [`${BASE}/`], path);
    assert.deepEqual(r.data.scopes_supported, ['mcp'], path);
  }
  const other = await fetch(`${BASE}/.well-known/oauth-protected-resource/other`);
  assert.match(await other.text(), /SPA/, 'an unrelated subpath still falls through');
});

// ── 2. Registration ──────────────────────────────────────────────────────────
const HOSTILE = '<script>alert("x")</script> & ChatGPT';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
let chatgpt;
await check('registration from chatgpt.com is accepted, with a secret that does not expire', async () => {
  const r = await postJson('/register', { redirect_uris: [CHATGPT_REDIRECT], client_name: HOSTILE, token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.client_id && r.data.client_secret);
  assert.equal(r.data.client_secret_expires_at, 0);
  chatgpt = r.data;
});
await check('claude.ai and a Claude Code loopback port are accepted', async () => {
  assert.equal((await postJson('/register', { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })).status, 201);
  assert.equal((await postJson('/register', { redirect_uris: ['http://localhost:33418/callback', 'http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' })).status, 201);
});
await check('registration to other hosts is refused', async () => {
  for (const uris of [
    ['https://evil.example/callback'],
    ['https://chatgpt.com.evil.example/cb'],
    ['http://chatgpt.com/connector_platform_oauth_redirect'],
    ['http://evil.example:8080/cb'],
    ['https://chatgpt.com:8443/cb'],
    [CHATGPT_REDIRECT, 'https://evil.example/cb'],
  ]) {
    const r = await postJson('/register', { redirect_uris: uris, client_name: 'x' });
    assert.equal(r.status, 400, uris.join(' '));
    assert.equal(r.data.error, 'invalid_client_metadata', uris.join(' '));
  }
});

// ── 3. The sign-in page ──────────────────────────────────────────────────────
function authorizeUrl(client, { challenge, state = 'st-123', redirect = CHATGPT_REDIRECT, resource = MCP_URL } = {}) {
  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'mcp', ...(state ? { state } : {}), ...(resource ? { resource } : {}),
  });
  return u;
}
const pendingFrom = html => html.match(/id="pending" value="([^"]+)"/)?.[1];

const first = pkce();
let pending;
await check('authorize renders the sign-in page with the client name escaped and the security headers', async () => {
  const r = await fetch(authorizeUrl(chatgpt, { challenge: first.challenge }), { redirect: 'manual' });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(!html.includes('<script>alert'), 'the hostile name is not markup');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; ChatGPT wants to use NPSA Tools as you'));
  assert.ok(html.includes('chatgpt.com'), 'shows the redirect host');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'script nonce in the CSP');
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`), 'inline script and style carry it');
  assert.ok(!/unsafe-inline/.test(csp));
  pending = pendingFrom(html);
  assert.ok(pending && pending.length >= 40, 'an unguessable pending id');
});
await check('authorize refuses another resource by redirecting with invalid_target', async () => {
  const r = await fetch(authorizeUrl(chatgpt, { challenge: first.challenge, resource: 'https://evil.example/mcp' }), { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, CHATGPT_REDIRECT);
  assert.equal(loc.searchParams.get('error'), 'invalid_target');
  assert.equal(loc.searchParams.get('state'), 'st-123');
});
await check('authorize refuses an unregistered redirect_uri outright', async () => {
  const r = await fetch(authorizeUrl(chatgpt, { challenge: first.challenge, redirect: 'https://chatgpt.com/elsewhere' }), { redirect: 'manual' });
  assert.equal(r.status, 400);
});

// ── 4. The code steps ────────────────────────────────────────────────────────
await check('request-code is proxied to the auth service and answers ok', async () => {
  const r = await postJson('/oauth/login/request', { pending, email: 'stuart@nonprofitsecurityadvisors.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { status: 'ok' });
  assert.deepEqual(codeRequests, ['stuart@nonprofitsecurityadvisors.com']);
});
await check('the code steps refuse an unknown pending id, a cross-origin page, and non-JSON', async () => {
  assert.equal((await postJson('/oauth/login/request', { pending: 'made-up', email: 'a@b.co' })).status, 400);
  assert.equal((await postJson('/oauth/login/verify', { pending: 'made-up', email: 'a@b.co', code: '123456' })).status, 400);
  assert.equal((await postJson('/oauth/login/request', { pending, email: 'a@b.co' }, { Origin: 'https://evil.example' })).status, 403);
  const form = await fetch(`${BASE}/oauth/login/request`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pending=${pending}&email=a@b.co` });
  assert.equal(form.status, 415);
  assert.equal(codeRequests.length, 1, 'none of those reached the auth service');
});
await check('a wrong code is 401 with a friendly message and issues no code', async () => {
  const r = await postJson('/oauth/login/verify', { pending, email: 'stuart@nonprofitsecurityadvisors.com', code: '000000' });
  assert.equal(r.status, 401);
  assert.match(r.data.error, /didn't work/);
  assert.equal(codesIssued, 0);
});
await check('a 429 from the auth service passes through', async () => {
  const r = await postJson('/oauth/login/verify', { pending, email: 'stuart@nonprofitsecurityadvisors.com', code: '999999' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /Too many/);
  assert.equal(codesIssued, 0);
});
await check('a login token the secret does not verify issues no code', async () => {
  const r = await postJson('/oauth/login/verify', { pending, email: 'forged@nonprofitsecurityadvisors.com', code: '123456' });
  assert.equal(r.status, 502);
  assert.equal(codesIssued, 0);
});
let firstCode;
await check('the right code redirects to the client with code and state', async () => {
  const r = await postJson('/oauth/login/verify', { pending, email: 'stuart@nonprofitsecurityadvisors.com', code: '123 456' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const loc = new URL(r.data.redirect);
  assert.equal(loc.origin + loc.pathname, CHATGPT_REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'st-123');
  firstCode = loc.searchParams.get('code');
  assert.ok(firstCode && firstCode.length >= 40);
  assert.equal(codesIssued, 1);
  assert.ok(oauthLog.some(l => l.startsWith('[oauth] sign-in stuart for ')), 'sign-in logged by username');
  assert.ok(!oauthLog.join('\n').includes('nonprofitsecurityadvisors.com'), 'no email in the log');
});
await check('the pending sign-in is single use', async () => {
  const r = await postJson('/oauth/login/verify', { pending, email: 'stuart@nonprofitsecurityadvisors.com', code: '123456' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /expired/);
});
await check('a pending sign-in expires after ten minutes', async () => {
  const p = pkce();
  const page = await (await fetch(authorizeUrl(chatgpt, { challenge: p.challenge }))).text();
  clock += 10 * 60 * 1000 + 1;
  try {
    assert.equal((await postJson('/oauth/login/request', { pending: pendingFrom(page), email: 'stuart@nonprofitsecurityadvisors.com' })).status, 400);
  } finally { clock -= 10 * 60 * 1000 + 1; }
});

// A full browser sign-in, for the checks that need a fresh code.
async function signIn(client, { redirect = CHATGPT_REDIRECT, email = 'stuart@nonprofitsecurityadvisors.com' } = {}) {
  const p = pkce();
  const page = await (await fetch(authorizeUrl(client, { challenge: p.challenge, redirect }))).text();
  const id = pendingFrom(page);
  await postJson('/oauth/login/request', { pending: id, email });
  const r = await postJson('/oauth/login/verify', { pending: id, email, code: '123456' });
  return { code: new URL(r.data.redirect).searchParams.get('code'), verifier: p.verifier };
}
const exchange = (client, code, verifier, extra = {}) => postForm('/token', {
  grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT,
  client_id: client.client_id, client_secret: client.client_secret, resource: MCP_URL, ...extra,
});

// ── 5. The token endpoint ────────────────────────────────────────────────────
let tokens;
await check('a wrong PKCE verifier is refused', async () => {
  const r = await exchange(chatgpt, firstCode, pkce().verifier);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_grant');
});
await check('a wrong client secret is refused', async () => {
  const r = await exchange(chatgpt, firstCode, first.verifier, { client_secret: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_client');
});
await check('the right verifier gets an access and refresh token', async () => {
  const r = await exchange(chatgpt, firstCode, first.verifier);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.token_type, 'Bearer');
  assert.equal(r.data.expires_in, 3600);
  assert.equal(r.data.scope, 'mcp');
  assert.ok(r.data.access_token && r.data.refresh_token && r.data.access_token !== r.data.refresh_token);
  tokens = r.data;
});
await check('only hashes of codes and tokens are stored', async () => {
  assert.equal(await store.getCode(firstCode), null);
  assert.ok(await store.getCode(sha256(firstCode)));
  assert.equal(await store.tokenByAccess(tokens.access_token), null);
  assert.equal((await store.tokenByAccess(sha256(tokens.access_token))).username, 'stuart');
});
await check('a code cannot be used twice, and a second use withdraws its tokens', async () => {
  const s = await signIn(chatgpt);
  const ok = await exchange(chatgpt, s.code, s.verifier);
  assert.equal(ok.status, 200);
  assert.equal((await mcpPost({ Authorization: `Bearer ${ok.data.access_token}` })).status, 200);
  const again = await exchange(chatgpt, s.code, s.verifier);
  assert.equal(again.status, 400);
  assert.equal(again.data.error, 'invalid_grant');
  assert.equal((await mcpPost({ Authorization: `Bearer ${ok.data.access_token}` })).status, 401, 'tokens from a replayed code are revoked');
});
await check('a different redirect_uri is refused', async () => {
  const s = await signIn(chatgpt);
  const r = await exchange(chatgpt, s.code, s.verifier, { redirect_uri: 'https://chatgpt.com/other' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_grant');
});
await check('a different resource is refused', async () => {
  const s = await signIn(chatgpt);
  const r = await exchange(chatgpt, s.code, s.verifier, { resource: 'https://evil.example/mcp' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_target');
});
await check('a code expires after sixty seconds', async () => {
  const s = await signIn(chatgpt);
  clock += 61 * 1000;
  try {
    const r = await exchange(chatgpt, s.code, s.verifier);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'invalid_grant');
  } finally { clock -= 61 * 1000; }
});
await check('another client cannot redeem the code', async () => {
  const other = (await postJson('/register', { redirect_uris: [CHATGPT_REDIRECT], client_name: 'Other' })).data;
  const s = await signIn(chatgpt);
  const r = await exchange(other, s.code, s.verifier);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_grant');
});

// ── 6. /mcp ───────────────────────────────────────────────────────────────────
await check('/mcp with the access token lists every tool, writes included', async () => {
  const client = await connect(tokens.access_token);
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.ok(names.includes('letters_stats') && names.includes('rep_add') && names.includes('client_delete'));
  const stats = JSON.parse((await client.callTool({ name: 'letters_stats', arguments: {} })).content[0].text);
  assert.equal(stats.actor, 'stuart', 'the loopback call is made as the person');
  await client.close();
});
await check('a write is audited and forwarded under the username', async () => {
  const client = await connect(tokens.access_token);
  const r = await client.callTool({ name: 'rep_add', arguments: { name: 'New Rep' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const last = received.at(-1);
  assert.equal(last.xActor, 'stuart');
  assert.equal(last.actor, 'stuart');
  assert.ok(mcpLog.includes('[mcp] write rep_add by stuart args=[name] ok'), mcpLog.join('\n'));
  await client.close();
});
await check('MCP_WRITE_KEYS narrows keys only: the OAuth caller still writes, a key outside it does not', async () => {
  process.env.MCP_WRITE_KEYS = 'some-other-key';
  try {
    const person = await connect(tokens.access_token);
    assert.ok((await person.listTools()).tools.some(t => t.name === 'rep_add'));
    await person.close();
    const key = await connect(TEAM_KEY);
    assert.ok(!(await key.listTools()).tools.some(t => t.name === 'rep_add'));
    await key.close();
  } finally { delete process.env.MCP_WRITE_KEYS; }
});
await check('an MCP_API_KEYS key still works and is named by its fingerprint', async () => {
  const client = await connect(TEAM_KEY);
  await client.callTool({ name: 'rep_add', arguments: { name: 'Key Rep' } });
  assert.equal(received.at(-1).xActor, fingerprint(TEAM_KEY));
  await client.close();
});
await check('/mcp with no token is 401 pointing at the resource metadata', async () => {
  const r = await mcpPost();
  assert.equal(r.status, 401);
  const h = r.headers.get('www-authenticate');
  assert.match(h, /^Bearer /);
  assert.match(h, /realm="npsa-tools"/);
  assert.ok(h.includes(`resource_metadata="${PRM_URL}"`), h);
  assert.ok(!h.includes('error='), 'no error code when no token was sent');
});
await check('/mcp with a made-up token is 401 invalid_token', async () => {
  const r = await mcpPost({ Authorization: 'Bearer not-a-real-token' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
});
let rotated;
await check('refresh rotates the pair and the old refresh token is refused', async () => {
  const r = await postForm('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: chatgpt.client_id, client_secret: chatgpt.client_secret });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.access_token, tokens.access_token);
  assert.notEqual(r.data.refresh_token, tokens.refresh_token);
  rotated = r.data;
  assert.equal((await mcpPost({ Authorization: `Bearer ${rotated.access_token}` })).status, 200);
  const again = await postForm('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: chatgpt.client_id, client_secret: chatgpt.client_secret });
  assert.equal(again.status, 400);
  assert.equal(again.data.error, 'invalid_grant');
});
await check('revoking the access token ends it on /mcp', async () => {
  const r = await postForm('/revoke', { token: rotated.access_token, client_id: chatgpt.client_id, client_secret: chatgpt.client_secret });
  assert.equal(r.status, 200);
  assert.equal((await mcpPost({ Authorization: `Bearer ${rotated.access_token}` })).status, 401);
});
await check('an access token stops working after an hour; its refresh still works until thirty days', async () => {
  const s = await signIn(chatgpt);
  const t = (await exchange(chatgpt, s.code, s.verifier)).data;
  assert.equal((await mcpPost({ Authorization: `Bearer ${t.access_token}` })).status, 200);
  clock += 3600 * 1000 + 1;
  try {
    const r = await mcpPost({ Authorization: `Bearer ${t.access_token}` });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
    const fresh = await postForm('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: chatgpt.client_id, client_secret: chatgpt.client_secret });
    assert.equal(fresh.status, 200);
    clock += 31 * 24 * 3600 * 1000;
    const late = await postForm('/token', { grant_type: 'refresh_token', refresh_token: fresh.data.refresh_token, client_id: chatgpt.client_id, client_secret: chatgpt.client_secret });
    assert.equal(late.status, 400);
  } finally { clock = Date.now(); }
});
await check('a token recorded for another resource is refused on /mcp', async () => {
  const access = 'token-for-somewhere-else';
  await store.addTokens({
    accessHash: sha256(access), refreshHash: sha256('r-somewhere-else'), clientId: chatgpt.client_id, username: 'stuart',
    scopes: ['mcp'], resource: 'https://evil.example/mcp', family: 'x', accessExpires: Date.now() + 60000, refreshExpires: Date.now() + 60000,
  });
  assert.equal((await mcpPost({ Authorization: `Bearer ${access}` })).status, 401);
});

// ── 8. The SDK's own client, end to end ──────────────────────────────────────
await check("the MCP SDK's client OAuth flow connects and lists tools", async () => {
  const saved = {};
  const provider = {
    get redirectUrl() { return 'http://localhost:33418/callback'; },
    get clientMetadata() { return { client_name: 'SDK e2e', redirect_uris: ['http://localhost:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => saved.client,
    saveClientInformation: c => { saved.client = c; },
    tokens: () => saved.tokens,
    saveTokens: t => { saved.tokens = t; },
    redirectToAuthorization: u => { saved.authUrl = u; },
    saveCodeVerifier: v => { saved.verifier = v; },
    codeVerifier: () => saved.verifier,
  };
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: 'sdk-e2e', version: '0' });
  await assert.rejects(client.connect(transport), UnauthorizedError);
  assert.ok(saved.authUrl, 'the SDK was sent to /authorize');
  assert.equal(saved.authUrl.searchParams.get('resource'), MCP_URL);
  const id = pendingFrom(await (await fetch(saved.authUrl)).text());
  await postJson('/oauth/login/request', { pending: id, email: 'stuart@nonprofitsecurityadvisors.com' });
  const r = await postJson('/oauth/login/verify', { pending: id, email: 'stuart@nonprofitsecurityadvisors.com', code: '123456' });
  const back = new URL(r.data.redirect);
  assert.equal(back.origin + back.pathname, 'http://localhost:33418/callback');
  await transport.finishAuth(back.searchParams.get('code'));
  const client2 = new Client({ name: 'sdk-e2e', version: '0' });
  await client2.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider }));
  assert.ok((await client2.listTools()).tools.length > 20);
  await client2.close();
});

httpServer.close();

// ── 7. Unconfigured ──────────────────────────────────────────────────────────
delete process.env.AUTH_API_URL;
const plain = express();
const plainServer = await listen(plain);
const plainPort = plainServer.address().port;
plain.use(express.json());
const plainLog = [];
const none = registerOAuth(plain, { store: createMemoryOAuthStore(), log: l => plainLog.push(l) });
registerMcp(plain, { port: () => plainPort, internalKey: INTERNAL, oauth: none });
plain.get('*', (_req, res) => res.type('html').send('<!doctype html><title>SPA</title>'));
const PLAIN = `http://127.0.0.1:${plainPort}`;
const plainMcp = (headers = {}) => fetch(`${PLAIN}/mcp`, { method: 'POST', body: initBody, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } });

await check('with AUTH_API_URL unset nothing OAuth is mounted', async () => {
  assert.equal(none, null);
  assert.match(plainLog.join(' '), /not configured/);
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/authorize']) {
    const r = await fetch(`${PLAIN}${path}`);
    assert.match(await r.text(), /SPA/, `${path} falls to the SPA`);
  }
  for (const path of ['/register', '/token', '/revoke', '/oauth/login/request']) {
    assert.equal((await fetch(`${PLAIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, path);
  }
});
await check('with AUTH_API_URL unset /mcp behaves as before', async () => {
  const r = await plainMcp();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="npsa-tools"');
  assert.equal((await plainMcp({ Authorization: `Bearer ${TEAM_KEY}` })).status, 200);
  assert.equal((await plainMcp({ Authorization: `Bearer ${tokens.access_token}` })).status, 401);
  delete process.env.MCP_API_KEYS;
  assert.equal((await plainMcp({ Authorization: `Bearer ${TEAM_KEY}` })).status, 503);
});
await check('JWT_SECRET unset is also unconfigured', async () => {
  const cfgless = registerOAuth(express(), { env: { AUTH_API_URL: 'http://127.0.0.1:1', JWT_SECRET: '' }, log: () => {} });
  assert.equal(cfgless, null);
});

plainServer.close();
authServer.close();
console.log = realLog;
console.log(failures ? `\n${failures} check(s) failed` : '\nAll OAuth checks passed');
process.exit(failures ? 1 : 0);
