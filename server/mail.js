// The welcome email a new contact gets when they are added to a client's intake form.
//
// It works the way sharing a Drive file does: the person who was added gets a short
// note naming who added them and a link to the form. It is sent as the client's
// grant writer, so a reply lands in a real inbox and the thread reads like every
// other message from us.
//
// Sending uses the same service account as the Drive mirror, with the Gmail API and
// domain-wide delegation: the account asks Google for a token that acts as the grant
// writer (scope gmail.send only). That delegation is a Workspace admin setting, so
// until it is granted and INTAKE_WELCOME_EMAIL is set to "on", nothing is sent and
// the form behaves exactly as before.
//
// Setup, once (Workspace admin):
//   1. Google Cloud → the npsa-tools project → enable the Gmail API.
//   2. Copy the service account's client ID (Admin console shows it as "Client ID").
//   3. Admin console → Security → Access and data control → API controls →
//      Domain-wide delegation → Add new → that client ID, scope
//      https://www.googleapis.com/auth/gmail.send
//   4. Railway → INTAKE_WELCOME_EMAIL=on
// Step 3 lets the account send as anyone in the domain, so keep the scope to
// gmail.send and nothing wider.

import crypto from 'crypto';
import { accessToken } from './drive.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export function mailConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) && String(process.env.INTAKE_WELCOME_EMAIL || '').toLowerCase() === 'on';
}

/** The NPSA person a client's mail comes from: their grant writer, else the first NPSA contact. */
export function senderFor(contacts = []) {
  const npsa = contacts.filter(c => c.side === 'npsa');
  return npsa.find(c => /grant writer/i.test(c.role || '')) || npsa[0] || null;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * A header carrying anything but plain ASCII has to travel as MIME encoded words
 * (RFC 2047), or a mail client reads the UTF-8 bytes as Latin-1 and the em dash in
 * "Your NSGP intake form — Client" arrives as Ã¢Â€Â. Chunks stay well inside the
 * 75-character limit for one encoded word and split on character boundaries, so no
 * multi-byte character is ever cut in half.
 */
export function encodeHeader(value) {
  const v = String(value == null ? '' : value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words = [];
  let chunk = '';
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 36) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
/** A display name and address, with anything that would break the header stripped out. */
const addr = (name, email) => {
  const n = String(name || '').replace(/[\r\n"<>]/g, '').trim();
  if (!n) return email;
  // An encoded word stands on its own; a plain name is quoted.
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `${encodeHeader(n)} <${email}>`;
};

/** Subject and body for one welcome. Kept here so it can be read and changed without touching the plumbing. */
/**
 * Text a client typed, made safe to put on one line of an email body. The "added by"
 * name comes straight off the intake form; with newlines in it, it could start a new
 * MIME part of its own and send whatever it liked under the grant writer's name.
 */
export function oneLine(raw, max = 80) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function welcomeMessage({ client, contact, addedBy, sender, intakeUrl }) {
  const hi = oneLine(firstName(contact.name), 40);
  const by = oneLine(addedBy);
  const who = by ? `${by} added you to` : 'You have been added to';
  // "Director of Grants, your grant writer" reads oddly under a signature; the client already knows.
  const role = String(sender?.role || '').replace(/,?\s*your grant writer/i, '').trim();
  const signoff = [sender?.name, role ? `${role}, Nonprofit Security Advisors` : 'Nonprofit Security Advisors', sender?.phone]
    .filter(Boolean).join('\n');
  const subject = `Your NSGP intake form — ${client.name}`;
  const text = [
    hi ? `Hi ${hi},` : 'Hello,',
    '',
    `${who} ${client.name}'s Nonprofit Security Grant Program intake form, which we use to gather everything the application needs.`,
    '',
    'Open the form:',
    intakeUrl,
    '',
    'It saves as you type, so you can fill in what you know and come back to the rest. The link opens the form without a password, so please keep it inside your organization.',
    '',
    'Reply to this email with any questions.',
    '',
    signoff,
  ].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#15242e">',
    `<p>${hi ? `Hi ${esc(hi)},` : 'Hello,'}</p>`,
    `<p>${esc(who)} <b>${esc(client.name)}</b>'s Nonprofit Security Grant Program intake form, which we use to gather everything the application needs.</p>`,
    `<p><a href="${esc(intakeUrl)}" style="background:#003c60;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Open the intake form</a></p>`,
    '<p>It saves as you type, so you can fill in what you know and come back to the rest. The link opens the form without a password, so please keep it inside your organization.</p>',
    '<p>Reply to this email with any questions.</p>',
    `<p style="color:#566571">${esc(signoff).replace(/\n/g, '<br>')}</p>`,
    '</div>',
  ].join('');
  return { subject, text, html };
}

/** One RFC 822 message, plain text with an HTML alternative. */
// The boundary is random per message: a fixed one is a string anyone can type into a
// form field to close the real part and open one of their own.
export function buildRaw({ from, to, subject, text, html, boundary = `npsa-${crypto.randomBytes(16).toString('hex')}` }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Sends one welcome as the grant writer. Throws on any failure; callers treat it as best-effort. */
export async function sendWelcome({ client, contact, addedBy, sender, intakeUrl, credentials, sendUrl = SEND_URL, tokenUrl }) {
  if (!sender?.email) throw new Error('no NPSA sender on this client');
  const { subject, text, html } = welcomeMessage({ client, contact, addedBy, sender, intakeUrl });
  const raw = buildRaw({ from: addr(sender.name, sender.email), to: addr(contact.name, contact.email), subject, text, html });
  const token = await accessToken({ credentials, tokenUrl, scope: SCOPE, subject: sender.email });
  const r = await fetch(sendUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id) throw new Error(`Gmail send failed: ${data.error?.message || data.error || r.status}`);
  return { id: data.id, to: contact.email, from: sender.email, subject };
}
