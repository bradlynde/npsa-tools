/**
 * Shared upload plumbing: what a file really is, what to call it, and how a
 * browser is allowed to post one straight to this service.
 *
 * Two features take files — the client intake page and the grant knowledge tab —
 * and both have to go around Vercel, whose functions cap a request body at
 * 4.5 MB. What they accept and who may post differ; what does not differ lives
 * here: deciding the type from the bytes, cleaning up the filename, reading a
 * multipart body, answering CORS for a known origin, and the signed tickets that
 * let a browser reach this service without carrying the team key.
 */

import crypto from 'crypto';
import express from 'express';

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const PDF = 'application/pdf';
export const PNG = 'image/png';
export const JPEG = 'image/jpeg';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What to call each type, and what to name the file, when a person sees it. */
export const TYPE_NAME = { [PDF]: 'PDF', [PNG]: 'PNG', [JPEG]: 'JPG', [DOCX]: 'Word', [XLSX]: 'Excel' };
export const TYPE_EXT = { [PDF]: 'pdf', [PNG]: 'png', [JPEG]: 'jpg', [DOCX]: 'docx', [XLSX]: 'xlsx' };

const MAGIC = [
  [PDF, Buffer.from('%PDF')],
  [JPEG, Buffer.from([0xff, 0xd8, 0xff])],
  [PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47])],
];
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * The type a buffer can prove it is, or null. A browser's declared type is
 * whatever the extension says, so the bytes get the deciding word.
 *
 * A Word or Excel file is a zip, so its first four bytes only say "some zip".
 * What makes it an Office file is the package manifest, and the manifest names
 * the application that wrote it — so that is what is looked for, in the first
 * 8 KB, which is where the manifest sits.
 */
export function sniffType(buf) {
  for (const [mime, magic] of MAGIC) if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) return mime;
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP)) {
    const head = buf.subarray(0, 8192).toString('latin1');
    if (head.includes('[Content_Types].xml')) {
      if (head.includes('wordprocessingml.document')) return DOCX;
      if (head.includes('spreadsheetml.sheet')) return XLSX;
    }
  }
  return null;
}

/** The intake page's narrower set: the three things a client is ever asked to send. */
export function sniffUploadType(buf) {
  const mime = sniffType(buf);
  return mime === PDF || mime === PNG || mime === JPEG ? mime : null;
}

export function safeFilename(name) {
  const n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  return (n || 'file').slice(0, 200);
}

/** A filename a download header can carry unambiguously, whatever the original was. */
export function contentDisposition(filename, { inline = false } = {}) {
  const name = safeFilename(filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ── Reading the body ─────────────────────────────────────────────────────── */

/** The raw body of a direct multipart post, with a little room over the file cap for the envelope. */
export const rawUploadBody = (max = UPLOAD_MAX_BYTES) => express.raw({ type: 'multipart/form-data', limit: max + 1024 * 1024 });

export function uploadBodyError(err, req, res, next) {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'File too large — please keep uploads under 25 MB.' });
  if (err) return res.status(400).json({ error: 'Could not read the upload. Please try again.' });
  return next();
}

/** The posted form, or null when the body was not multipart this service could read. */
export async function readMultipart(req) {
  if (!Buffer.isBuffer(req.body)) return null;
  try { return await new Response(req.body, { headers: { 'content-type': req.get('content-type') || '' } }).formData(); }
  catch { return null; }
}

/* ── Talking to a browser on another origin ───────────────────────────────── */

const originOf = u => { try { return new URL(String(u)).origin; } catch { return ''; } };

/**
 * Answers CORS for a fixed list of origins and no others. A request from
 * anywhere else still runs — whatever gate the route has is the one that
 * decides — it just comes back without the header that would let a foreign
 * page read the answer.
 */
export function corsForOrigins(origins, { methods = 'POST, OPTIONS', headers = 'Content-Type' } = {}) {
  const allow = new Set(origins.map(originOf).filter(Boolean));
  return (req, res, next) => {
    const origin = originOf(req.get('origin'));
    const ok = Boolean(origin) && allow.has(origin);
    if (ok) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', methods);
      res.set('Access-Control-Allow-Headers', headers);
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(ok ? 204 : 403).end();
    return next();
  };
}

/** This service's own address as seen from outside, for handing a browser a direct link. */
export function baseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

/* ── Tickets ──────────────────────────────────────────────────────────────── */

/**
 * Short-lived signed tickets. A ticket says "this person may put one file here"
 * or "this link may fetch that file", and says it without the team key — which
 * is what lets the browser talk to this service directly instead of through the
 * Vercel passthrough and its 4.5 MB cap.
 *
 * Signed rather than remembered: nothing to hold in memory, nothing lost when
 * the service restarts halfway through an upload, and a retry after a dropped
 * connection still works. Each ticket names its target and who asked for it, so
 * the most a replayed one can do is what the person already could.
 */
export function ticketSigner(key) {
  const secret = crypto.createHmac('sha256', String(key || crypto.randomBytes(32).toString('hex')))
    .update('npsa-upload-ticket').digest();
  const mac = body => crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return {
    sign(payload, ttlMs, nowMs = Date.now()) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + ttlMs })).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    /** The payload, or null if the ticket was forged, mangled, or has run out. */
    read(ticket, nowMs = Date.now()) {
      const [body, sig] = String(ticket || '').split('.');
      if (!body || !sig) return null;
      const want = Buffer.from(mac(body));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return typeof payload?.exp === 'number' && payload.exp > nowMs ? payload : null;
      } catch { return null; }
    },
  };
}
