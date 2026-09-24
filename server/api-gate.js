// One gate in front of every /api route.
//
// This service is on a public Railway URL. The Sales Toolbox routes it started with
// (letters, reps, templates, pre-call, polish, marketing) were written with no auth
// of their own, on the assumption that only the toolbox would ever call them. That
// left letters, prospect bookings and OpenAI spend open to anyone holding the URL,
// and the URL is in the docs. This closes the whole /api tree by default, so a route
// added later is locked unless it is deliberately let through.
//
// Four ways in:
//
//   1. The per-process internal key (X-Internal-Key). The MCP layer presents it on
//      its loopback calls.
//   2. A key from MCP_API_KEYS as a bearer token. The Vercel shell's proxies hold one.
//   3. The person's own login token (the HS256 JWT the auth service issues) as a
//      bearer token, verified against JWT_SECRET. The Sales Toolbox runs in an iframe
//      straight off this origin and calls these routes from the browser, so it
//      carries the token the shell hands it. With JWT_SECRET unset this way is shut,
//      never open.
//   4. The Zapier secret (X-Zap-Secret), on the Zapier and backfill routes only,
//      compared timing-safe. With ZAPIER_WEBHOOK_SECRET unset those routes refuse
//      everything rather than accepting everything.
//
// Let through untouched: /api/clients, /api/intake and /api/grant-knowledge. Those
// modules gate every route themselves (a team key, or the client's intake token, or
// a signed upload ticket), and the client-facing ones must stay reachable without
// a team login.
//
//   app.use('/api', apiGate({ internalKey }))   // FIRST, ahead of the body parsers

import crypto from 'crypto';
import { splitKeys, keyMatches, nameFor, mayAssertActor, cleanActor } from './mcp.js';

// Modules with their own gate on every route. Matched against the path under /api.
export const SELF_GATED = /^\/(clients|intake|grant-knowledge)(\/|$)/;

// Routes the Zaps and the backfill scripts call, and nothing else does.
export const ZAP_ROUTES = new Set([
  'POST /marketing/bookings/ingest',
  'POST /marketing/wins/ingest',
  'POST /marketing/wins/reconcile',
  'POST /marketing/applications/ingest',
  'POST /marketing/applications/reconcile',
  'POST /marketing/bookings/backfill-calendly',
  'POST /marketing/sync/push',
  'POST /marketing/sync/echo',
  'POST /marketing/sync/salesforce',
]);

function safeEqual(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True only when ZAPIER_WEBHOOK_SECRET is set and the request carries it. */
export function zapSecretOk(req) {
  return safeEqual(req.get('x-zap-secret'), process.env.ZAPIER_WEBHOOK_SECRET);
}

/**
 * Verifies an HS256 JWT from the auth service, the same check the Vercel shell makes.
 * No secret, no verification: `ok` is false rather than "probably fine".
 */
export function verifyJwt(token, secret) {
  if (!secret || !token) return { ok: false };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false };
  const [header, payload, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (!safeEqual(signature, expected)) return { ok: false };
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.exp && Date.now() / 1000 > claims.exp) return { ok: false };
    return { ok: true, username: typeof claims.username === 'string' ? claims.username : '' };
  } catch {
    return { ok: false };
  }
}

/** Who is calling, or null. */
export function identify(req, internalKey) {
  if (internalKey && safeEqual(req.get('x-internal-key'), internalKey)) {
    return { actor: cleanActor(req.get('x-actor')) || 'internal', kind: 'mcp' };
  }
  const presented = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!presented) return null;
  const keys = splitKeys(process.env.MCP_API_KEYS || process.env.MCP_API_KEY);
  if (keys.length && keyMatches(presented, keys)) {
    const asserted = mayAssertActor(presented) ? cleanActor(req.get('x-actor')) : '';
    return { actor: asserted || nameFor(presented), kind: asserted ? 'user' : 'key' };
  }
  const jwt = verifyJwt(presented, process.env.JWT_SECRET);
  if (jwt.ok) return { actor: cleanActor(jwt.username) || 'toolbox', kind: 'user' };
  return null;
}

export function apiGate({ internalKey } = {}) {
  return (req, res, next) => {
    const path = req.path;
    if (SELF_GATED.test(path)) return next();

    if (ZAP_ROUTES.has(`${req.method} ${path}`)) {
      if (!process.env.ZAPIER_WEBHOOK_SECRET) {
        return res.status(503).json({ error: 'ZAPIER_WEBHOOK_SECRET is not configured on this server' });
      }
      if (!zapSecretOk(req)) return res.status(401).json({ error: 'Unauthorized' });
      req.actor = 'zapier';
      req.actorKind = 'zap';
      return next();
    }

    const who = identify(req, internalKey);
    if (who) {
      req.actor = who.actor;
      req.actorKind = who.kind;
      return next();
    }
    res.set('WWW-Authenticate', 'Bearer realm="npsa-tools"');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}
