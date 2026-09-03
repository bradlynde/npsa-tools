// Optional Google Drive mirror for intake uploads.
//
// Uploads are stored in Postgres first (see intake.js). If a service account is
// configured — GOOGLE_SERVICE_ACCOUNT_JSON holding the key file's contents — each
// upload is also pushed into the client's Phase 2 folder, so the team keeps
// finding files where they always were. The push is best-effort: a Drive failure
// is logged and the Postgres copy stands, and the client never sees it.
//
// No googleapis dependency. The service account signs a JWT (RS256, the same
// primitive the Salesforce connector uses), trades it for an access token, and
// the file goes up as one multipart/related request. Both endpoints can be
// overridden so the smoke test can stand in for Google.
//
// Setup, once: create a service account in Google Cloud, enable the Drive API,
// download its JSON key into the Railway variable, and add the account's email to
// the Shared Drive that holds client folders as a Content Manager. A folder on a
// personal My Drive also works if it is shared with that email, but then the
// service account owns the files and they count against its own quota.

import crypto from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink';
const SCOPE = 'https://www.googleapis.com/auth/drive';

export function driveConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function credentialsFromEnv() {
  try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
}

/** A short-lived Drive access token for the service account. */
export async function accessToken({ credentials, tokenUrl = TOKEN_URL, now = Date.now() } = {}) {
  const sa = credentials || credentialsFromEnv();
  if (!sa.client_email || !sa.private_key) throw new Error('service account JSON lacks client_email or private_key');
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || tokenUrl, iat, exp: iat + 3600 }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key));
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`Drive token request failed: ${data.error_description || data.error || r.status}`);
  return data.access_token;
}

/** Puts one file in a folder. Returns { id, url }. Throws on any failure. */
export async function uploadToDrive({ folderId, filename, mime, content, credentials, tokenUrl, uploadUrl = UPLOAD_URL }) {
  if (!folderId) throw new Error('the client has no upload folder id');
  const token = await accessToken({ credentials, tokenUrl });
  const boundary = `npsa${crypto.randomBytes(12).toString('hex')}`;
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id) throw new Error(`Drive upload failed: ${data.error?.message || data.error || r.status}`);
  return { id: data.id, url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}
