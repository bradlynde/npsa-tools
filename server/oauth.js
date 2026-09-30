// OAuth 2.1 sign-in for the MCP endpoint.
//
// ChatGPT and claude.ai connect to remote MCP servers with OAuth: they register
// themselves (dynamic client registration), send the person to /authorize, and
// trade the code they get back for a bearer token. This module is that
// authorization server, built on the MCP SDK's mcpAuthRouter and handlers (which
// do the request parsing, PKCE S256 check, client authentication, metadata and
// rate limiting). What is ours: the storage, the redirect-URI allowlist, and the
// sign-in page in the middle, which uses the same emailed-code auth service the
// toolbox login does. So an OAuth caller is a named person, and their edits carry
// their username into the MCP audit line and the X-Actor loopback header.
//
//   GET  /.well-known/oauth-authorization-server         (SDK)
//   GET  /.well-known/oauth-protected-resource[/mcp]     (SDK, plus the bare path)
//   POST /register   GET|POST /authorize   POST /token   POST /revoke   (SDK)
//   POST /oauth/login/request   {pending, email}         -> {status: "ok"}
//   POST /oauth/login/verify    {pending, email, code}   -> {redirect}
//
// Off unless AUTH_API_URL and JWT_SECRET are both set: then nothing here is
// mounted and /mcp takes MCP_API_KEYS keys exactly as before.
//
// Only hashes of the pending id, codes and tokens are stored. Client registrations
// are stored whole, secret included, because the SDK's client authentication
// compares the secret as given.
//
//   ensureOAuthSchema(pool)                        // at boot
//   const oauth = registerOAuth(app, { pool })     // before registerMcp and the SPA fallback
//   registerMcp(app, { port, internalKey, oauth })

import crypto from 'crypto';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { verifyJwt } from './api-gate.js';
import { cleanActor } from './mcp.js';

export const DEFAULT_PUBLIC_URL = 'https://loe-generator-production.up.railway.app';
export const SCOPE = 'mcp';
// https redirect hosts allowed at registration, exact host match. OAUTH_REDIRECT_HOSTS replaces the list.
export const DEFAULT_REDIRECT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com'];
// Claude Code and other native clients listen on a loopback port of their choosing.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

const PENDING_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;
const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
// Wrong codes allowed against one pending sign-in before it is thrown away.
const MAX_CODE_ATTEMPTS = 10;
const UPSTREAM_TIMEOUT = 10_000;

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// ── Config ────────────────────────────────────────────────────────────────────

/** The OAuth settings, or null when AUTH_API_URL or JWT_SECRET is unset. */
export function oauthConfig(env = process.env) {
  const authApiUrl = String(env.AUTH_API_URL || '').trim().replace(/\/+$/, '');
  const jwtSecret = env.JWT_SECRET || '';
  if (!authApiUrl || !jwtSecret) return null;
  const base = String(env.MCP_PUBLIC_URL || DEFAULT_PUBLIC_URL).trim().replace(/\/+$/, '');
  const issuerUrl = new URL(base);
  const resourceUrl = new URL(`${base}/mcp`);
  const hosts = env.OAUTH_REDIRECT_HOSTS
    ? String(env.OAUTH_REDIRECT_HOSTS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_REDIRECT_HOSTS;
  return {
    authApiUrl,
    jwtSecret,
    issuerUrl,
    resourceUrl,
    origin: issuerUrl.origin,
    resourceMetadataUrl: `${issuerUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
    redirectHosts: new Set(hosts),
  };
}

/** Whether a client may register this redirect URI. */
export function redirectAllowed(uri, redirectHosts) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return !u.port && redirectHosts.has(u.hostname.toLowerCase());
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return false;
}

// A resource indicator compared as the resource, whatever trailing slash it came with.
const normResource = u => { try { const x = new URL(String(u)); x.hash = ''; return x.href.replace(/\/+$/, ''); } catch { return null; } };

// ── Storage ───────────────────────────────────────────────────────────────────

export async function ensureOAuthSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id   TEXT PRIMARY KEY,
      info        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_pending (
      id_hash     TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      params      JSONB NOT NULL,
      attempts    INT NOT NULL DEFAULT 0,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash       TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      username        TEXT NOT NULL,
      code_challenge  TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      resource        TEXT,
      scopes          TEXT NOT NULL DEFAULT '',
      expires_at      TIMESTAMPTZ NOT NULL,
      used_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id               SERIAL PRIMARY KEY,
      access_hash      TEXT NOT NULL UNIQUE,
      refresh_hash     TEXT NOT NULL UNIQUE,
      client_id        TEXT NOT NULL,
      username         TEXT NOT NULL,
      scopes           TEXT NOT NULL DEFAULT '',
      resource         TEXT,
      family           TEXT NOT NULL,
      access_expires   TIMESTAMPTZ NOT NULL,
      refresh_expires  TIMESTAMPTZ NOT NULL,
      revoked_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family);
  `);
}

const ms = d => (d == null ? null : new Date(d).getTime());
const splitScopes = s => String(s || '').split(' ').filter(Boolean);

const codeRow = r => r && ({
  clientId: r.client_id, username: r.username, codeChallenge: r.code_challenge, redirectUri: r.redirect_uri,
  resource: r.resource || null, scopes: splitScopes(r.scopes), expiresAt: ms(r.expires_at), usedAt: ms(r.used_at),
});
const tokenRow = r => r && ({
  clientId: r.client_id, username: r.username, scopes: splitScopes(r.scopes), resource: r.resource || null,
  family: r.family, accessExpires: ms(r.access_expires), refreshExpires: ms(r.refresh_expires), revokedAt: ms(r.revoked_at),
});

export function createOAuthStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  return {
    async getClient(id) { return (await one('SELECT info FROM oauth_clients WHERE client_id=$1', [id]))?.info; },
    async saveClient(info) {
      await pool.query('INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET info=EXCLUDED.info', [info.client_id, info]);
    },
    async addPending({ idHash, clientId, params, expiresAt }) {
      await pool.query('INSERT INTO oauth_pending (id_hash, client_id, params, expires_at) VALUES ($1,$2,$3,$4)', [idHash, clientId, params, new Date(expiresAt)]);
    },
    async getPending(idHash) {
      const r = await one('SELECT * FROM oauth_pending WHERE id_hash=$1', [idHash]);
      return r && { clientId: r.client_id, params: r.params, attempts: r.attempts, expiresAt: ms(r.expires_at) };
    },
    async countAttempt(idHash) {
      return (await one('UPDATE oauth_pending SET attempts=attempts+1 WHERE id_hash=$1 RETURNING attempts', [idHash]))?.attempts ?? null;
    },
    async takePending(idHash) {
      const r = await one('DELETE FROM oauth_pending WHERE id_hash=$1 RETURNING *', [idHash]);
      return r && { clientId: r.client_id, params: r.params, attempts: r.attempts, expiresAt: ms(r.expires_at) };
    },
    async addCode(c) {
      await pool.query(
        `INSERT INTO oauth_codes (code_hash, client_id, username, code_challenge, redirect_uri, resource, scopes, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [c.codeHash, c.clientId, c.username, c.codeChallenge, c.redirectUri, c.resource, c.scopes.join(' '), new Date(c.expiresAt)]);
    },
    async getCode(codeHash) { return codeRow(await one('SELECT * FROM oauth_codes WHERE code_hash=$1', [codeHash])); },
    async useCode(codeHash, at) {
      return codeRow(await one('UPDATE oauth_codes SET used_at=$2 WHERE code_hash=$1 AND used_at IS NULL RETURNING *', [codeHash, new Date(at)]));
    },
    async addTokens(t) {
      await pool.query(
        `INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, username, scopes, resource, family, access_expires, refresh_expires)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [t.accessHash, t.refreshHash, t.clientId, t.username, t.scopes.join(' '), t.resource, t.family, new Date(t.accessExpires), new Date(t.refreshExpires)]);
    },
    async tokenByAccess(hash) { return tokenRow(await one('SELECT * FROM oauth_tokens WHERE access_hash=$1', [hash])); },
    async tokenByRefresh(hash) { return tokenRow(await one('SELECT * FROM oauth_tokens WHERE refresh_hash=$1', [hash])); },
    // Revokes the pair a refresh token belongs to, only if it was still live: two
    // refreshes racing with the same token cannot both win.
    async spendRefresh(hash, at) {
      return tokenRow(await one('UPDATE oauth_tokens SET revoked_at=$2 WHERE refresh_hash=$1 AND revoked_at IS NULL RETURNING *', [hash, new Date(at)]));
    },
    async revoke(hash, clientId, at) {
      await pool.query('UPDATE oauth_tokens SET revoked_at=$3 WHERE (access_hash=$1 OR refresh_hash=$1) AND client_id=$2 AND revoked_at IS NULL', [hash, clientId, new Date(at)]);
    },
    async revokeFamily(family, at) {
      await pool.query('UPDATE oauth_tokens SET revoked_at=$2 WHERE family=$1 AND revoked_at IS NULL', [family, new Date(at)]);
    },
    async purge(at) {
      const now = new Date(at);
      const day = new Date(at - 24 * 60 * 60 * 1000);
      await pool.query('DELETE FROM oauth_pending WHERE expires_at < $1', [now]);
      await pool.query('DELETE FROM oauth_codes WHERE expires_at < $1', [day]);
      await pool.query('DELETE FROM oauth_tokens WHERE refresh_expires < $1 OR revoked_at < $1', [day]);
    },
  };
}

/** Same surface as createOAuthStore, in memory, for the smoke test (and a server with no database). */
export function createMemoryOAuthStore() {
  const clients = new Map(); const pending = new Map(); const codes = new Map(); const tokens = [];
  const copy = v => v && structuredClone(v);
  return {
    async getClient(id) { return copy(clients.get(id)); },
    async saveClient(info) { clients.set(info.client_id, copy(info)); },
    async addPending({ idHash, clientId, params, expiresAt }) { pending.set(idHash, { clientId, params: copy(params), attempts: 0, expiresAt }); },
    async getPending(idHash) { return copy(pending.get(idHash)) || null; },
    async countAttempt(idHash) { const p = pending.get(idHash); if (!p) return null; p.attempts += 1; return p.attempts; },
    async takePending(idHash) { const p = pending.get(idHash); pending.delete(idHash); return copy(p) || null; },
    async addCode(c) { codes.set(c.codeHash, { ...copy(c), resource: c.resource || null, usedAt: null }); },
    async getCode(codeHash) { return copy(codes.get(codeHash)) || null; },
    async useCode(codeHash, at) { const c = codes.get(codeHash); if (!c || c.usedAt) return null; c.usedAt = at; return copy(c); },
    async addTokens(t) { tokens.push({ ...copy(t), resource: t.resource || null, revokedAt: null }); },
    async tokenByAccess(hash) { return copy(tokens.find(t => t.accessHash === hash)) || null; },
    async tokenByRefresh(hash) { return copy(tokens.find(t => t.refreshHash === hash)) || null; },
    async spendRefresh(hash, at) { const t = tokens.find(x => x.refreshHash === hash); if (!t || t.revokedAt) return null; t.revokedAt = at; return copy(t); },
    async revoke(hash, clientId, at) {
      for (const t of tokens) if ((t.accessHash === hash || t.refreshHash === hash) && t.clientId === clientId && !t.revokedAt) t.revokedAt = at;
    },
    async revokeFamily(family, at) { for (const t of tokens) if (t.family === family && !t.revokedAt) t.revokedAt = at; },
    async purge(at) {
      for (const [k, p] of pending) if (p.expiresAt < at) pending.delete(k);
      for (const [k, c] of codes) if (c.expiresAt < at - 864e5) codes.delete(k);
      for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].refreshExpires < at - 864e5 || (tokens[i].revokedAt && tokens[i].revokedAt < at - 864e5)) tokens.splice(i, 1);
    },
  };
}

// ── Provider (the SDK's OAuthServerProvider) ──────────────────────────────────

export function createOAuthProvider({ store, config, now = Date.now, log = console.log }) {
  const resourceHref = normResource(config.resourceUrl.href);
  let lastPurge = 0;

  // A requested resource must be this server's /mcp.
  const checkResource = resource => {
    if (resource && normResource(resource) !== resourceHref) {
      throw new InvalidTargetError(`This server only issues tokens for ${config.resourceUrl.href}`);
    }
  };

  async function issueTokens({ clientId, username, scopes, resource, family }) {
    const access = randomToken();
    const refresh = randomToken();
    const t = now();
    await store.addTokens({
      accessHash: sha256(access), refreshHash: sha256(refresh), clientId, username, scopes, resource, family,
      accessExpires: t + ACCESS_TTL, refreshExpires: t + REFRESH_TTL,
    });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: scopes.join(' ') };
  }

  const clientsStore = {
    getClient: id => store.getClient(id),
    async registerClient(client) {
      const uris = client.redirect_uris || [];
      if (!uris.length) throw new InvalidClientMetadataError('At least one redirect_uri is required');
      const refused = uris.filter(u => !redirectAllowed(u, config.redirectHosts));
      if (refused.length) throw new InvalidClientMetadataError(`redirect_uri not allowed on this server: ${refused.join(', ')}`);
      await store.saveClient(client);
      log(`[oauth] registered client ${client.client_id} (${cleanActor(client.client_name) || 'unnamed'})`);
      return client;
    },
  };

  return {
    clientsStore,

    async authorize(client, params, res) {
      checkResource(params.resource);
      const t = now();
      if (t - lastPurge > PENDING_TTL) { lastPurge = t; store.purge(t).catch(err => log(`[oauth] purge failed: ${err.message}`)); }
      const pendingId = randomToken();
      await store.addPending({
        idHash: sha256(pendingId),
        clientId: client.client_id,
        expiresAt: t + PENDING_TTL,
        params: {
          state: params.state ?? null,
          // One scope exists. Anything else asked for is simply not granted (the token response says what was).
          scopes: [SCOPE],
          codeChallenge: params.codeChallenge,
          redirectUri: params.redirectUri,
          resource: params.resource ? params.resource.href : null,
        },
      });
      const nonce = crypto.randomBytes(16).toString('base64');
      res.set({
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      });
      res.status(200).type('html').send(signInPage({
        nonce, pendingId,
        clientName: client.client_name || 'An app',
        redirectHost: new URL(params.redirectUri).host,
      }));
    },

    async challengeForAuthorizationCode(client, code) {
      const row = await store.getCode(sha256(code));
      if (!row || row.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      if (row.expiresAt <= now()) throw new InvalidGrantError('Authorization code has expired');
      return row.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
      const codeHash = sha256(code);
      const row = await store.getCode(codeHash);
      if (!row || row.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      if (row.usedAt) {
        // A code presented twice may have been stolen: whatever it bought is withdrawn.
        await store.revokeFamily(codeHash, now());
        throw new InvalidGrantError('Authorization code has already been used');
      }
      if (row.expiresAt <= now()) throw new InvalidGrantError('Authorization code has expired');
      if (redirectUri !== undefined ? redirectUri !== row.redirectUri : client.redirect_uris.length !== 1) {
        throw new InvalidGrantError('redirect_uri does not match the authorization request');
      }
      checkResource(resource);
      if (resource && row.resource && normResource(resource) !== normResource(row.resource)) {
        throw new InvalidTargetError('resource does not match the authorization request');
      }
      if (!(await store.useCode(codeHash, now()))) throw new InvalidGrantError('Authorization code has already been used');
      return issueTokens({
        clientId: client.client_id, username: row.username, scopes: row.scopes,
        resource: row.resource || (resource ? resource.href : null), family: codeHash,
      });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const hash = sha256(refreshToken);
      const row = await store.tokenByRefresh(hash);
      if (!row || row.clientId !== client.client_id || row.revokedAt || row.refreshExpires <= now()) {
        throw new InvalidGrantError('Invalid refresh token');
      }
      let granted = row.scopes;
      if (scopes?.length) {
        granted = scopes.filter(s => row.scopes.includes(s));
        if (!granted.length) throw new InvalidScopeError('Requested scope was not granted');
      }
      checkResource(resource);
      const spent = await store.spendRefresh(hash, now());
      if (!spent) throw new InvalidGrantError('Invalid refresh token');
      return issueTokens({
        clientId: client.client_id, username: row.username, scopes: granted,
        resource: row.resource || (resource ? resource.href : null), family: row.family,
      });
    },

    async verifyAccessToken(token) {
      const row = await store.tokenByAccess(sha256(token));
      if (!row) throw new InvalidTokenError('Invalid access token');
      if (row.revokedAt) throw new InvalidTokenError('Access token has been revoked');
      if (row.accessExpires <= now()) throw new InvalidTokenError('Access token has expired');
      return {
        token,
        clientId: row.clientId,
        scopes: row.scopes,
        expiresAt: Math.floor(row.accessExpires / 1000),
        ...(row.resource ? { resource: new URL(row.resource) } : {}),
        extra: { username: row.username },
      };
    },

    async revokeToken(client, { token }) {
      await store.revoke(sha256(token), client.client_id, now());
    },
  };
}

// ── Sign-in page ──────────────────────────────────────────────────────────────

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function signInPage({ nonce, pendingId, clientName, redirectHost }) {
  const name = escapeHtml(String(clientName).slice(0, 80));
  const host = escapeHtml(redirectHost);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to NPSA Tools</title>
<style nonce="${nonce}">
  :root { --navy: #003c60; --ink: #1c2530; --muted: #5b6875; --line: #d6dde4; --bg: #f3f6f9; --err: #a4262c; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 420px; background: #fff; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  header { background: var(--navy); color: #fff; padding: 18px 24px; font-weight: 600; letter-spacing: .02em; }
  section { padding: 24px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); word-break: break-all; }
  label { display: block; font-weight: 600; margin: 0 0 6px; }
  input { width: 100%; padding: 12px; font-size: 16px; border: 1px solid var(--line); border-radius: 8px; }
  input:focus { outline: 2px solid var(--navy); outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 12px; font-size: 16px; font-weight: 600; color: #fff; background: var(--navy);
    border: 0; border-radius: 8px; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .link { background: none; color: var(--navy); padding: 8px 0 0; width: auto; font-weight: 500; text-decoration: underline; }
  .msg { min-height: 1.5em; margin: 12px 0 0; color: var(--err); }
  .msg.ok { color: var(--muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>NPSA Tools</header>
  <section>
    <h1>${name} wants to use NPSA Tools as you</h1>
    <p>Sign in with your NPSA email. You'll be sent back to <span class="host">${host}</span>, and what it reads or changes will be recorded under your name.</p>
    <form id="step1" novalidate>
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
      <button type="submit">Email me a code</button>
    </form>
    <form id="step2" novalidate hidden>
      <label for="code">Code from the email</label>
      <input id="code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" required>
      <button type="submit">Sign in</button>
      <button type="button" class="link" id="back">Use a different email</button>
    </form>
    <p class="msg" id="msg" role="status" aria-live="polite"></p>
    <input type="hidden" id="pending" value="${escapeHtml(pendingId)}">
  </section>
</main>
<script nonce="${nonce}">
(function () {
  var pending = document.getElementById('pending').value;
  var step1 = document.getElementById('step1'), step2 = document.getElementById('step2');
  var email = document.getElementById('email'), code = document.getElementById('code'), msg = document.getElementById('msg');
  function say(text, ok) { msg.textContent = text || ''; msg.className = ok ? 'msg ok' : 'msg'; }
  function busy(form, on) { Array.prototype.forEach.call(form.querySelectorAll('button[type=submit]'), function (b) { b.disabled = on; }); }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  step1.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!email.value.trim()) { say('Enter your email.'); return; }
    busy(step1, true); say('');
    post('/oauth/login/request', { pending: pending, email: email.value.trim() }).then(function (r) {
      busy(step1, false);
      if (r.status !== 200) { say(r.data.error || 'Something went wrong. Try again.'); return; }
      step1.hidden = true; step2.hidden = false; code.focus();
      say('If that address has an NPSA account, a code is on its way.', true);
    }, function () { busy(step1, false); say('Could not reach the server. Try again.'); });
  });
  step2.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!code.value.trim()) { say('Enter the code from the email.'); return; }
    busy(step2, true); say('');
    post('/oauth/login/verify', { pending: pending, email: email.value.trim(), code: code.value.trim() }).then(function (r) {
      if (r.status === 200 && r.data.redirect) { say('Signed in. Returning you now.', true); window.location.replace(r.data.redirect); return; }
      busy(step2, false); say(r.data.error || 'Something went wrong. Try again.');
    }, function () { busy(step2, false); say('Could not reach the server. Try again.'); });
  });
  document.getElementById('back').addEventListener('click', function () {
    step2.hidden = true; step1.hidden = false; code.value = ''; say(''); email.focus();
  });
})();
</script>
</body>
</html>`;
}

// ── The sign-in steps ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
const EXPIRED = 'This sign-in has expired. Go back to the app and connect again.';

function loginRoutes({ store, config, now, fetchImpl, log }) {
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));

  // Only this page's own script posts here: JSON (so a cross-site form cannot),
  // and from this origin when the browser says where it is from.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const origin = req.get('origin');
    if (origin && origin !== config.origin) return res.status(403).json({ error: 'Cross-origin request refused' });
    next();
  });

  const livePending = async id => {
    if (typeof id !== 'string' || !id || id.length > 100) return null;
    const p = await store.getPending(sha256(id));
    return p && p.expiresAt > now() ? p : null;
  };

  async function upstream(path, body) {
    const r = await fetchImpl(`${config.authApiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    let data = null;
    try { data = await r.json(); } catch { /* not json */ }
    return { status: r.status, data: data || {} };
  }
  const detail = d => (typeof d?.detail === 'string' ? d.detail.slice(0, 200) : '');

  router.post('/request', async (req, res) => {
    try {
      const { pending, email } = req.body || {};
      if (!(await livePending(pending))) return res.status(400).json({ error: EXPIRED });
      const addr = typeof email === 'string' ? email.trim() : '';
      if (!EMAIL_RE.test(addr) || addr.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
      const r = await upstream('/auth/request-code', { email: addr });
      if (r.status === 429) return res.status(429).json({ error: detail(r.data) || 'Too many sign-in attempts. Wait a few minutes and try again.' });
      if (r.status >= 500) log(`[oauth] request-code upstream ${r.status}`);
      // Whether or not the address has an account, the answer is the same.
      return res.json({ status: 'ok' });
    } catch (err) {
      log(`[oauth] request-code failed: ${err.message}`);
      return res.status(502).json({ error: 'The sign-in service is not answering. Try again in a minute.' });
    }
  });

  router.post('/verify', async (req, res) => {
    try {
      const { pending, email, code } = req.body || {};
      const p = await livePending(pending);
      if (!p) return res.status(400).json({ error: EXPIRED });
      const idHash = sha256(pending);
      const addr = typeof email === 'string' ? email.trim() : '';
      const entered = typeof code === 'string' ? code.replace(/\s+/g, '') : String(code ?? '');
      if (!addr || !entered || entered.length > 64 || addr.length > 254) {
        return res.status(400).json({ error: 'Enter your email and the code from the email.' });
      }
      const attempts = await store.countAttempt(idHash);
      if (attempts == null) return res.status(400).json({ error: EXPIRED });
      if (attempts > MAX_CODE_ATTEMPTS) {
        await store.takePending(idHash);
        return res.status(400).json({ error: 'Too many wrong codes. Go back to the app and connect again.' });
      }

      const r = await upstream('/auth/verify-code', { email: addr, code: entered });
      if (r.status === 401) return res.status(401).json({ error: "That code didn't work. Check the most recent email from NPSA and try again." });
      if (r.status === 429) return res.status(429).json({ error: detail(r.data) || 'Too many attempts. Wait a few minutes and try again.' });
      if (r.status !== 200) {
        log(`[oauth] verify-code upstream ${r.status}`);
        return res.status(502).json({ error: 'The sign-in service had a problem. Try again in a minute.' });
      }
      const jwt = verifyJwt(r.data.token, config.jwtSecret);
      const username = jwt.ok ? String(jwt.username || '').trim() : '';
      if (!username) {
        log('[oauth] verify-code returned a token that does not verify or names nobody');
        return res.status(502).json({ error: 'The sign-in service had a problem. Try again in a minute.' });
      }

      // The pending record is spent here and nowhere else: one sign-in, one code.
      const taken = await store.takePending(idHash);
      if (!taken || taken.expiresAt <= now()) return res.status(400).json({ error: EXPIRED });
      const client = await store.getClient(taken.clientId);
      if (!client) return res.status(400).json({ error: EXPIRED });

      const authCode = randomToken();
      const { params } = taken;
      await store.addCode({
        codeHash: sha256(authCode), clientId: taken.clientId, username,
        codeChallenge: params.codeChallenge, redirectUri: params.redirectUri,
        resource: params.resource || null, scopes: params.scopes || [SCOPE], expiresAt: now() + CODE_TTL,
      });
      const target = new URL(params.redirectUri);
      target.searchParams.set('code', authCode);
      if (params.state != null) target.searchParams.set('state', params.state);
      log(`[oauth] sign-in ${cleanActor(username)} for ${cleanActor(client.client_name) || taken.clientId}`);
      return res.json({ redirect: target.href });
    } catch (err) {
      log(`[oauth] verify failed: ${err.message}`);
      return res.status(502).json({ error: 'The sign-in service is not answering. Try again in a minute.' });
    }
  });

  return router;
}

// ── Express wiring ────────────────────────────────────────────────────────────

// Railway's edge proxy appends the caller's address to X-Forwarded-For, so the
// last entry is the one the proxy saw; entries before it are whatever the caller
// sent. Without this every caller would share the proxy's address, and one bucket.
function rateKey(r) {
  const xff = String(r.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const addr = xff.length ? xff[xff.length - 1] : (r.socket?.remoteAddress || 'unknown');
  // An IPv6 caller controls a whole /64 or more; count the /56 as one.
  return addr.includes(':') ? addr.split(':').slice(0, 4).join(':') : addr;
}

/**
 * Mounts the authorization server and the sign-in steps, and returns what /mcp
 * needs to accept its tokens. Returns null, mounting nothing, when AUTH_API_URL
 * or JWT_SECRET is unset.
 */
export function registerOAuth(app, { pool = null, store, now = Date.now, fetchImpl = fetch, env = process.env, log = console.log } = {}) {
  const config = oauthConfig(env);
  if (!config) {
    log('[oauth] not configured (AUTH_API_URL or JWT_SECRET unset): /mcp takes MCP_API_KEYS keys only');
    return null;
  }
  if (!store) {
    if (pool) store = createOAuthStore(pool);
    else {
      log('[oauth] no DATABASE_URL: OAuth clients and tokens are kept in memory and lost on restart');
      store = createMemoryOAuthStore();
    }
  }
  const provider = createOAuthProvider({ store, config, now, log });
  const rateLimit = { keyGenerator: rateKey };

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: config.issuerUrl,
    resourceServerUrl: config.resourceUrl,
    scopesSupported: [SCOPE],
    resourceName: 'NPSA Tools',
    authorizationOptions: { rateLimit },
    tokenOptions: { rateLimit },
    revocationOptions: { rateLimit },
    // The SDK expires a client's secret after 30 days by default, which would
    // strand a connector whose refresh token is still good. Registrations last.
    clientRegistrationOptions: { rateLimit, clientSecretExpirySeconds: 0 },
  }));
  // The SDK serves the protected-resource document at the path-specific URL
  // (RFC 9728); some clients look for it at the bare path first.
  const prm = {
    resource: config.resourceUrl.href,
    authorization_servers: [config.issuerUrl.href],
    scopes_supported: [SCOPE],
    resource_name: 'NPSA Tools',
  };
  const bareResourceMetadata = metadataHandler(prm);
  app.use('/.well-known/oauth-protected-resource', (req, res, next) => (req.path === '/' ? bareResourceMetadata(req, res, next) : next()));
  app.use('/oauth/login', loginRoutes({ store, config, now, fetchImpl, log }));

  return {
    config,
    provider,
    resourceMetadataUrl: config.resourceMetadataUrl,
    /** The person behind a bearer token good for /mcp, or null. */
    async authenticate(token) {
      let info;
      try { info = await provider.verifyAccessToken(token); } catch { return null; }
      if (!info.scopes.includes(SCOPE)) return null;
      if (info.resource && normResource(info.resource.href) !== normResource(config.resourceUrl.href)) return null;
      const username = String(info.extra?.username || '');
      return username ? { username, clientId: info.clientId } : null;
    },
  };
}
