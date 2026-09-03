// Grant clients: registration, the tokenized intake link, and intake answers.
//
// This replaces the Google Apps Script intake app's Registry sheet and per-client
// tabs. A client is a row; their answers are (client, key) → value against a fixed
// question catalog (server/intake-questions.json, the FIELDS array the Apps Script
// build used, with each key's element kind). The catalog is the contract: a seed
// that names a key the page does not render is refused with the offending keys,
// instead of landing silently in an "Other" bucket nobody sees.
//
// Two kinds of caller, two gates:
//
//   Team routes (/api/clients/*, /api/intake/questions) need either a bearer key
//   from MCP_API_KEYS, or the X-Internal-Key the process minted at boot — which is
//   how the MCP layer's loopback calls get in without a second secret to manage.
//   With MCP_API_KEYS unset and no internal key, nothing gets in. Fail closed.
//
//   Client routes (GET /client/:slug, /api/intake/:slug/*) need only the client's
//   token, exactly like the Apps Script links. Clients forward these to their own
//   staff, so there is deliberately no login in front of them. The token travels
//   in the page URL (?t=) and, for API calls, in the X-Intake-Token header.
//
// Storage is behind a small store interface so the routes can be exercised with
// an in-memory store and no database (scripts/intake-smoke.mjs). The Postgres
// store is the real one; its schema is created on boot like letters and
// nsgp_deadlines.
//
//   ensureIntakeSchema(pool)                          // at boot
//   registerIntake(app, { store, internalKey, publicBase })   // before the SPA fallback

import crypto from 'crypto';
import express from 'express';
import { readFileSync } from 'fs';
import { driveConfigured, uploadToDrive } from './drive.js';
import { STATE_REFERENCE } from './nsgp-deadlines.js';
import { splitKeys, keyMatches, fingerprint } from './mcp.js';

// ── Catalog ───────────────────────────────────────────────────────────────────

const CATALOG = JSON.parse(readFileSync(new URL('./intake-questions.json', import.meta.url), 'utf8'));
const STATE_CONFIG = JSON.parse(readFileSync(new URL('./intake-state-config.json', import.meta.url), 'utf8'));
const NPSA_TEAM = JSON.parse(readFileSync(new URL('./intake-team.json', import.meta.url), 'utf8')).contacts;

export const QUESTIONS = CATALOG.questions;
const QUESTION_BY_KEY = new Map(QUESTIONS.map(q => [q.key, q]));
export const SECTIONS = [...new Set(QUESTIONS.map(q => q.section))];

// The sections the client is actually asked to fill, for the headline count. The
// wish list is excluded on purpose: 363 of its keys are legitimately blank for a
// one-site client with six interests, so counting them makes every client look
// half done. It gets its own per-section line instead.
const CORE_SECTIONS = new Set(SECTIONS.filter(s => /^[1-5]\. /.test(s) || s === 'Locations' || s === 'Programs' || s === 'Uploads'));
const CORE_KEYS = QUESTIONS.filter(q => CORE_SECTIONS.has(q.section) && q.kind !== 'meta').map(q => q.key);
const CHECKLIST_STEMS = QUESTIONS.filter(q => q.key.startsWith('chk_status_')).map(q => q.key.slice('chk_status_'.length));

// The wish list is 3 facilities × 20 items × 6 fields, and a client only ever
// fills the items they care about. So the measure is: which items carry a
// priority (the `_int` select, 1 = fund first), and how many of that item's five
// detail fields (currently have, what & why, where, quantity, cost) are answered.
const WISH_DETAILS = ['cur', 'desc', 'where', 'qty', 'cost'];
const WISH_FACILITIES = [1, 2, 3].map(n => ({
  n,
  items: QUESTIONS.filter(q => q.key.startsWith(`wl_f${n}_`) && q.key.endsWith('_int')).map(q => ({
    stem: q.key.slice(`wl_f${n}_`.length, -'_int'.length),
    label: q.label.replace(/\s+—\s+Priority.*$/i, ''),
  })),
}));

export function stateConfig(state) {
  const st = String(state || '').toUpperCase();
  return STATE_CONFIG.states[st] || { ...STATE_CONFIG.fallback, saa: st };
}

// ── Validation ────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set(['questions', 'new', 'demo', 'admin']);
const STATUSES = ['active', 'submitted', 'cancelled', 'closed'];
const TOKEN_RE = /^[a-z0-9]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_VALUE = 20000;

// Uploads: the same guards the Apps Script had, plus the file's own first bytes as
// the deciding word on type, since a browser's declared type is whatever the
// extension says.
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAGIC = [
  ['application/pdf', Buffer.from('%PDF')],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
];
export function sniffUploadType(buf) {
  for (const [mime, magic] of UPLOAD_MAGIC) if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) return mime;
  return null;
}
function safeFilename(name) {
  const n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  return (n || 'file').slice(0, 200);
}

class BadRequest extends Error {
  constructor(message, extra) { super(message); this.status = 400; this.extra = extra; }
}

export function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}

function validSlug(slug) {
  const s = String(slug || '').trim();
  if (!SLUG_RE.test(s) || s.length < 3 || s.length > 60) throw new BadRequest('slug must be 3–60 chars of a-z, 0-9 and single hyphens');
  if (RESERVED_SLUGS.has(s)) throw new BadRequest(`"${s}" is reserved`);
  return s;
}

function validState(state) {
  const st = String(state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) throw new BadRequest('state must be a two-letter code');
  return st;
}

function validDate(d, field) {
  if (d === undefined || d === null || d === '') return null;
  if (!DATE_RE.test(String(d))) throw new BadRequest(`${field} must be YYYY-MM-DD`);
  return String(d);
}

const SIDES = ['client', 'npsa'];
function validContact(c, label) {
  const email = String(c?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new BadRequest(`${label}.email is not an email address`);
  const side = c.side === undefined ? 'client' : String(c.side);
  if (!SIDES.includes(side)) throw new BadRequest(`${label}.side must be "client" or "npsa"`);
  return {
    name: String(c.name || '').trim().slice(0, 120), email, role: String(c.role || '').trim().slice(0, 120),
    phone: String(c.phone || '').trim().slice(0, 40), side, is_primary: Boolean(c.is_primary),
  };
}
function validContacts(list, field = 'contacts') {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BadRequest(`${field} must be an array`);
  return list.map((c, i) => validContact(c, `${field}[${i}]`));
}

function validEmails(list, field) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BadRequest(`${field} must be an array`);
  return list.map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
}

function text(v, field, max = 2000) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') throw new BadRequest(`${field} must be text`);
  return String(v).slice(0, max);
}

/**
 * Normalises a {key: value} object into rows the store can write. Every key must
 * be in the catalog; `allowMeta` is for the team route (imports carry _status).
 * Nothing is returned if anything is wrong, so a bad batch never half-lands.
 */
export function normaliseAnswers(answers, { allowMeta = false } = {}) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new BadRequest('answers must be an object of key → value');
  const keys = Object.keys(answers);
  if (!keys.length) throw new BadRequest('answers is empty');
  const unknown = keys.filter(k => !QUESTION_BY_KEY.has(k));
  if (unknown.length) throw new BadRequest(`Unknown intake keys: ${unknown.join(', ')}. Use the question catalog for the exact keys.`, { unknown_keys: unknown });
  const meta = allowMeta ? [] : keys.filter(k => QUESTION_BY_KEY.get(k).kind === 'meta');
  if (meta.length) throw new BadRequest(`These keys are set by the server, not by the page: ${meta.join(', ')}`, { unknown_keys: meta });
  return keys.map(k => {
    const v = answers[k];
    if (v !== null && typeof v === 'object') throw new BadRequest(`${k}: value must be text, not an object`);
    return { key: k, value: v === null || v === undefined ? '' : String(v).slice(0, MAX_VALUE) };
  });
}

// ── Tokens and links ──────────────────────────────────────────────────────────

export function mintToken() {
  return crypto.randomBytes(10).toString('hex');
}

function tokenMatches(presented, expected) {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicBaseFor(req, configured) {
  if (configured) return String(configured).replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

export function intakeUrl(base, slug, token) {
  return `${base}/client/${encodeURIComponent(slug)}?t=${token}`;
}

// A copied link can arrive as ?client%3Dslug%26t%3Dtoken&source=gmail&… — the
// encoded '=' and '&' hide the real parameters. Same rescue the Apps Script did.
export function healToken(query, rawQuery) {
  if (query.t) return String(query.t);
  try {
    const raw = decodeURIComponent(String(rawQuery || ''));
    const m = raw.match(/(?:^|[?&]|%26)t=([A-Za-z0-9]+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// ── Derived views ─────────────────────────────────────────────────────────────

const checklistLabel = stem => (QUESTION_BY_KEY.get(`chk_status_${stem}`)?.label || stem).replace(/\s+—\s+status$/i, '');

export function summarise(answers) {
  const val = k => answers.get(k)?.value || '';
  const core = CORE_KEYS.filter(k => val(k) !== '').length;
  const checklist = CHECKLIST_STEMS.filter(s => val(`chk_status_${s}`) === 'Completed').length;
  return { core: { answered: core, total: CORE_KEYS.length }, checklist: { completed: checklist, total: CHECKLIST_STEMS.length } };
}

function uploadView(u, slug) {
  return {
    id: u.id, key: u.key, label: QUESTION_BY_KEY.get(u.key)?.label || u.key, filename: u.filename, mime: u.mime, size_bytes: u.size_bytes,
    uploaded_by: u.uploaded_by, uploaded_at: u.uploaded_at, drive_url: u.drive_url || null,
    download_path: `/api/clients/${encodeURIComponent(slug)}/uploads/${u.id}`,
  };
}

function statusView(client, answers, base, uploads = []) {
  const val = k => answers.get(k)?.value || '';
  const sections = SECTIONS.map(section => {
    const keys = QUESTIONS.filter(q => q.section === section && q.kind !== 'meta');
    return { section, answered: keys.filter(q => val(q.key) !== '').length, total: keys.length };
  });
  const wish_list = WISH_FACILITIES.map(f => {
    const items = f.items
      .map(it => {
        const priority = val(`wl_f${f.n}_${it.stem}_int`);
        if (!priority) return null;
        const answered = WISH_DETAILS.filter(d => val(`wl_f${f.n}_${it.stem}_${d}`) !== '').length;
        return { stem: it.stem, label: it.label, priority: Number(priority) || priority, answered, total: WISH_DETAILS.length };
      })
      .filter(Boolean)
      .sort((a, b) => (a.priority > b.priority ? 1 : a.priority < b.priority ? -1 : 0));
    return {
      facility: f.n, name: val(`loc${f.n}_name`), prioritized: items.length,
      details: { answered: items.reduce((n, it) => n + it.answered, 0), total: items.length * WISH_DETAILS.length },
      items,
    };
  });
  const items = CHECKLIST_STEMS.map(stem => ({
    stem, label: checklistLabel(stem),
    status: val(`chk_status_${stem}`) || 'Not started',
    due: val(`chk_due_${stem}`), owner: val(`chk_who_${stem}`), note: val(`chk_note_${stem}`),
  }));
  const s = summarise(answers);
  return {
    slug: client.slug, name: client.name, state: client.state, phase: client.phase, status: client.status,
    intake_url: intakeUrl(base, client.slug, client.token),
    submitted_at: client.submitted_at, last_client_activity_at: client.last_client_activity_at,
    filled_by: val('_filled_by'), status_line: val('_status'),
    core: s.core, sections, wish_list, checklist: { ...s.checklist, items },
    uploads: uploads.map(u => uploadView(u, client.slug)),
  };
}

// What the client page shows on its Contacts tab: the NPSA people first, then the
// client's own people. added_by tells the page which rows the client may remove.
function contactsView(contacts) {
  const pub = c => ({ name: c.name, role: c.role, email: c.email, phone: c.phone || '', added_by: c.added_by || '' });
  return {
    npsa: contacts.filter(c => c.side === 'npsa').map(pub),
    client: contacts.filter(c => c.side !== 'npsa').map(pub),
  };
}

function clientView(client, base) {
  const { token, ...rest } = client;
  return { ...rest, intake_url: intakeUrl(base, client.slug, token), saa: STATE_REFERENCE.states[client.state]?.saa || stateConfig(client.state).saa || null };
}

// ── Stores ────────────────────────────────────────────────────────────────────

const CLIENT_FIELDS = ['name', 'state', 'phase', 'status', 'program_track', 'drive_folder_id', 'upload_folder_id', 'asana_project_gid', 'kickoff_date', 'notes'];

export async function ensureIntakeSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id                      SERIAL PRIMARY KEY,
      slug                    TEXT NOT NULL UNIQUE,
      name                    TEXT NOT NULL,
      state                   TEXT NOT NULL,
      token                   TEXT NOT NULL UNIQUE,
      phase                   INT  NOT NULL DEFAULT 2,
      status                  TEXT NOT NULL DEFAULT 'active',
      program_track           TEXT NOT NULL DEFAULT '',
      drive_folder_id         TEXT NOT NULL DEFAULT '',
      upload_folder_id        TEXT NOT NULL DEFAULT '',
      asana_project_gid       TEXT NOT NULL DEFAULT '',
      kickoff_date            DATE,
      notes                   TEXT NOT NULL DEFAULT '',
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW(),
      submitted_at            TIMESTAMPTZ,
      last_client_activity_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS client_contacts (
      id          SERIAL PRIMARY KEY,
      client_id   INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name        TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT '',
      is_primary  BOOLEAN NOT NULL DEFAULT false,
      added_by    TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (client_id, email)
    );
    ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
    ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS side  TEXT NOT NULL DEFAULT 'client';
    CREATE TABLE IF NOT EXISTS intake_answers (
      client_id   INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (client_id, key)
    );
    CREATE TABLE IF NOT EXISTS intake_uploads (
      id            SERIAL PRIMARY KEY,
      client_id     INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      key           TEXT NOT NULL,
      filename      TEXT NOT NULL,
      mime          TEXT NOT NULL,
      size_bytes    INT  NOT NULL,
      content       BYTEA,
      drive_file_id TEXT NOT NULL DEFAULT '',
      drive_url     TEXT NOT NULL DEFAULT '',
      uploaded_by   TEXT NOT NULL DEFAULT 'client',
      uploaded_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

const UPLOAD_COLS = 'id, client_id, key, filename, mime, size_bytes, drive_file_id, drive_url, uploaded_by, uploaded_at';

const CLIENT_COLS = `id, slug, name, state, token, phase, status, program_track, drive_folder_id, upload_folder_id,
  asana_project_gid, to_char(kickoff_date, 'YYYY-MM-DD') AS kickoff_date, notes, created_at, updated_at,
  submitted_at, last_client_activity_at`;

/** Postgres-backed store. Every method takes and returns plain objects. */
export function createIntakeStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const contactsFor = async id => (await pool.query(
    `SELECT id, name, email, role, phone, side, is_primary, added_by, created_at FROM client_contacts WHERE client_id=$1
      ORDER BY (side = 'npsa') DESC, is_primary DESC, id`, [id])).rows;
  const withContacts = async row => row && { ...row, contacts: await contactsFor(row.id) };

  return {
    async createClient(c) {
      const dup = await one('SELECT 1 FROM clients WHERE slug=$1', [c.slug]);
      if (dup) { const e = new Error(`slug "${c.slug}" is already registered`); e.status = 409; throw e; }
      const row = await one(
        `INSERT INTO clients (slug, name, state, token, phase, status, program_track, drive_folder_id, upload_folder_id, asana_project_gid, kickoff_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${CLIENT_COLS}`,
        [c.slug, c.name, c.state, c.token, c.phase, c.status, c.program_track, c.drive_folder_id, c.upload_folder_id, c.asana_project_gid, c.kickoff_date, c.notes]);
      return withContacts(row);
    },
    async getClient(slug) {
      return withContacts(await one(`SELECT ${CLIENT_COLS} FROM clients WHERE slug=$1`, [slug]));
    },
    async listClients({ status, phase, search }) {
      const { rows } = await pool.query(
        `SELECT ${CLIENT_COLS} FROM clients
          WHERE ($1 = '' OR status = $1) AND ($2 = 0 OR phase = $2)
            AND ($3 = '' OR name ILIKE '%' || $3 || '%' OR slug ILIKE '%' || $3 || '%')
          ORDER BY name`, [status || '', phase || 0, search || '']);
      return rows;
    },
    async updateClient(slug, patch) {
      const fields = Object.keys(patch).filter(k => CLIENT_FIELDS.includes(k));
      const sets = fields.map((k, i) => `${k}=$${i + 2}`);
      if (patch.submitted_at !== undefined) sets.push(`submitted_at=$${fields.length + 2}`);
      sets.push('updated_at=NOW()');
      const params = [slug, ...fields.map(k => patch[k])];
      if (patch.submitted_at !== undefined) params.push(patch.submitted_at);
      return withContacts(await one(`UPDATE clients SET ${sets.join(', ')} WHERE slug=$1 RETURNING ${CLIENT_COLS}`, params));
    },
    async rotateToken(slug, token) {
      return withContacts(await one(`UPDATE clients SET token=$2, updated_at=NOW() WHERE slug=$1 RETURNING ${CLIENT_COLS}`, [slug, token]));
    },
    async addContacts(clientId, contacts, addedBy) {
      for (const c of contacts) {
        await pool.query(
          `INSERT INTO client_contacts (client_id, name, email, role, phone, side, is_primary, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (client_id, email) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE client_contacts.name END,
             role = CASE WHEN EXCLUDED.role <> '' THEN EXCLUDED.role ELSE client_contacts.role END,
             phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE client_contacts.phone END,
             side = EXCLUDED.side,
             is_primary = client_contacts.is_primary OR EXCLUDED.is_primary`,
          [clientId, c.name, c.email, c.role, c.phone, c.side, c.is_primary, addedBy]);
      }
    },
    async removeContacts(clientId, emails) {
      if (emails.length) await pool.query('DELETE FROM client_contacts WHERE client_id=$1 AND email = ANY($2)', [clientId, emails]);
    },
    async getAnswers(clientId) {
      const { rows } = await pool.query('SELECT key, value, updated_at, updated_by FROM intake_answers WHERE client_id=$1', [clientId]);
      return new Map(rows.map(r => [r.key, r]));
    },
    async answerStats(clientIds) {
      if (!clientIds.length) return {};
      const { rows } = await pool.query(
        `SELECT client_id,
                COUNT(*) FILTER (WHERE key = ANY($2) AND value <> '')::int AS core_answered,
                COUNT(*) FILTER (WHERE key LIKE 'chk_status_%' AND value = 'Completed')::int AS checklist_completed,
                MAX(value) FILTER (WHERE key = '_filled_by') AS filled_by
           FROM intake_answers WHERE client_id = ANY($1) GROUP BY client_id`, [clientIds, CORE_KEYS]);
      return Object.fromEntries(rows.map(r => [r.client_id, r]));
    },
    async upsertAnswers(clientId, rows, by, { clientActivity = false } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of rows) {
          await client.query(
            `INSERT INTO intake_answers (client_id, key, value, updated_at, updated_by) VALUES ($1,$2,$3,NOW(),$4)
             ON CONFLICT (client_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
            [clientId, r.key, r.value, by]);
        }
        if (clientActivity) await client.query('UPDATE clients SET last_client_activity_at=NOW() WHERE id=$1', [clientId]);
        await client.query('COMMIT');
      } catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
      return rows.length;
    },
    async addUpload(clientId, u) {
      return one(
        `INSERT INTO intake_uploads (client_id, key, filename, mime, size_bytes, content, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${UPLOAD_COLS}`,
        [clientId, u.key, u.filename, u.mime, u.size_bytes, u.content, u.uploaded_by]);
    },
    async setUploadDrive(id, { drive_file_id, drive_url }) {
      await pool.query('UPDATE intake_uploads SET drive_file_id=$2, drive_url=$3 WHERE id=$1', [id, drive_file_id, drive_url]);
    },
    async listUploads(clientId) {
      return (await pool.query(`SELECT ${UPLOAD_COLS} FROM intake_uploads WHERE client_id=$1 ORDER BY uploaded_at DESC, id DESC`, [clientId])).rows;
    },
    async getUpload(clientId, id) {
      return one(`SELECT ${UPLOAD_COLS}, content FROM intake_uploads WHERE client_id=$1 AND id=$2`, [clientId, id]);
    },
  };
}

/** In-memory store with the same surface, for the smoke test. */
export function createMemoryStore() {
  const clients = []; const contacts = []; const answers = new Map(); const uploads = []; let nextId = 1; let nextContactId = 1; let nextUploadId = 1;
  const now = () => new Date();
  const find = slug => clients.find(c => c.slug === slug) || null;
  const view = c => c && { ...c, contacts: contacts.filter(x => x.client_id === c.id).sort((a, b) => ((b.side === 'npsa') - (a.side === 'npsa')) || (b.is_primary - a.is_primary) || (a.id - b.id)) };
  const bucket = id => { if (!answers.has(id)) answers.set(id, new Map()); return answers.get(id); };
  return {
    async createClient(c) {
      if (find(c.slug)) { const e = new Error(`slug "${c.slug}" is already registered`); e.status = 409; throw e; }
      const row = { id: nextId++, ...c, created_at: now(), updated_at: now(), submitted_at: null, last_client_activity_at: null };
      clients.push(row); return view(row);
    },
    async getClient(slug) { return view(find(slug)); },
    async listClients({ status, phase, search }) {
      const q = (search || '').toLowerCase();
      return clients.filter(c => (!status || c.status === status) && (!phase || c.phase === phase)
        && (!q || c.name.toLowerCase().includes(q) || c.slug.includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    },
    async updateClient(slug, patch) {
      const c = find(slug); if (!c) return null;
      for (const k of CLIENT_FIELDS) if (patch[k] !== undefined) c[k] = patch[k];
      if (patch.submitted_at !== undefined) c.submitted_at = patch.submitted_at;
      c.updated_at = now(); return view(c);
    },
    async rotateToken(slug, token) { const c = find(slug); if (!c) return null; c.token = token; c.updated_at = now(); return view(c); },
    async addContacts(clientId, list, addedBy) {
      for (const x of list) {
        const cur = contacts.find(c => c.client_id === clientId && c.email === x.email);
        if (cur) { if (x.name) cur.name = x.name; if (x.role) cur.role = x.role; if (x.phone) cur.phone = x.phone; cur.side = x.side; cur.is_primary = cur.is_primary || x.is_primary; }
        else contacts.push({ id: nextContactId++, client_id: clientId, phone: '', side: 'client', ...x, added_by: addedBy, created_at: now() });
      }
    },
    async removeContacts(clientId, emails) {
      for (let i = contacts.length - 1; i >= 0; i--) if (contacts[i].client_id === clientId && emails.includes(contacts[i].email)) contacts.splice(i, 1);
    },
    async getAnswers(clientId) { return new Map(bucket(clientId)); },
    async answerStats(ids) {
      return Object.fromEntries(ids.map(id => {
        const s = summarise(bucket(id));
        return [id, { core_answered: s.core.answered, checklist_completed: s.checklist.completed, filled_by: bucket(id).get('_filled_by')?.value || null }];
      }));
    },
    async upsertAnswers(clientId, rows, by, { clientActivity = false } = {}) {
      const b = bucket(clientId);
      for (const r of rows) b.set(r.key, { key: r.key, value: r.value, updated_at: now(), updated_by: by });
      if (clientActivity) clients.find(c => c.id === clientId).last_client_activity_at = now();
      return rows.length;
    },
    async addUpload(clientId, u) {
      const row = { id: nextUploadId++, client_id: clientId, ...u, drive_file_id: '', drive_url: '', uploaded_at: now() };
      uploads.push(row);
      const { content, ...meta } = row; return meta;
    },
    async setUploadDrive(id, { drive_file_id, drive_url }) { Object.assign(uploads.find(u => u.id === id), { drive_file_id, drive_url }); },
    async listUploads(clientId) { return uploads.filter(u => u.client_id === clientId).map(({ content, ...m }) => m).reverse(); },
    async getUpload(clientId, id) { return uploads.find(u => u.client_id === clientId && u.id === id) || null; },
  };
}

// ── Gates ─────────────────────────────────────────────────────────────────────

export function teamGate({ internalKey }) {
  return (req, res, next) => {
    const internal = req.get('x-internal-key') || '';
    if (internalKey && tokenMatches(internal, internalKey)) {
      req.actor = String(req.get('x-actor') || 'internal').slice(0, 40);
      return next();
    }
    const keys = splitKeys(process.env.MCP_API_KEYS || process.env.MCP_API_KEY);
    const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (keys.length && presented && keyMatches(presented, keys)) {
      req.actor = fingerprint(presented);
      return next();
    }
    res.set('WWW-Authenticate', 'Bearer realm="npsa-tools"');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function errorPage(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NSGP — Client Information Collection</title></head><body>
<div style="font-family:system-ui;max-width:560px;margin:80px auto;text-align:center;color:#15242E">
<div style="font-size:13px;letter-spacing:.1em;color:#6C7732;font-weight:700;text-transform:uppercase">Nonprofit Security Grant Program</div>
<h2 style="color:#003C60">Client Information Collection</h2><p style="color:#566571">${escapeHtml(message)}</p></div></body></html>`;
}

const NOT_RECOGNISED = 'This link isn’t recognized. Please check with Nonprofit Security Advisors.';
const INVALID = 'This link is invalid or has expired.';

// ── The page ──────────────────────────────────────────────────────────────────
//
// server/intake/client.html is the form the Apps Script app served, with its six
// template tags turned into {{placeholders}} that are filled here as JSON. The
// values land inside an inline <script>, so the JSON is made safe for that spot
// the way the Apps Script did it: '<' and '>' escaped so a value can never close
// the script tag, and the two Unicode line separators that break JS strings.

const TEMPLATE_URL = new URL('./intake/client.html', import.meta.url);
let pageTemplate;

function jsForInject(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function renderClientPage({ client, stateConfig, existing, contacts = { npsa: [], client: [] }, apiBase = '', uploadBase = '' }) {
  if (pageTemplate === undefined) {
    try { pageTemplate = readFileSync(TEMPLATE_URL, 'utf8'); } catch { pageTemplate = null; }
  }
  if (!pageTemplate) return null;
  const vars = { client: client.slug, token: client.token, clientName: client.name, state: client.state, stateConfig, existing, contacts, apiBase, uploadBase };
  return pageTemplate.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? jsForInject(vars[k]) : m));
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerIntake(app, { store, internalKey, publicBase, renderPage = renderClientPage, apiBase = '', uploadBase = '', drive } = {}) {
  // Drive mirror: injectable for tests, otherwise on only when the key is set.
  if (drive === undefined) drive = driveConfigured() ? { upload: uploadToDrive } : null;
  const base = req => publicBaseFor(req, publicBase);
  const team = teamGate({ internalKey });

  const guard = fn => async (req, res) => {
    if (!store) return res.status(503).json({ error: 'Storage not configured' });
    try { await fn(req, res); }
    catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('intake route error:', err);
      res.status(status).json({ error: err.message, ...(err.extra || {}) });
    }
  };

  const loadClient = async (req, res) => {
    const c = await store.getClient(String(req.params.slug || ''));
    if (!c) { res.status(404).json({ error: 'No such client' }); return null; }
    return c;
  };

  // A client-token check for /api/intake/:slug/*. Wrong or missing token gets the
  // same answer as an unknown slug, so the endpoint does not confirm which slugs exist.
  const clientAuth = async (req, res) => {
    const c = await store.getClient(String(req.params.slug || ''));
    const presented = req.get('x-intake-token') || '';
    if (!c || !tokenMatches(presented, c.token)) { res.status(401).json({ error: INVALID }); return null; }
    return c;
  };

  // ── Team ──

  app.get('/api/intake/questions', team, (req, res) => {
    const section = String(req.query.section || '').toLowerCase();
    const prefix = String(req.query.prefix || '');
    let rows = QUESTIONS;
    if (section) rows = rows.filter(q => q.section.toLowerCase() === section);
    if (prefix) rows = rows.filter(q => q.key.startsWith(prefix));
    res.json({ count: rows.length, sections: SECTIONS, questions: rows });
  });

  app.get('/api/clients', team, guard(async (req, res) => {
    const status = String(req.query.status || 'active');
    const phase = req.query.phase ? parseInt(req.query.phase, 10) : 0;
    const rows = await store.listClients({ status: status === 'all' ? '' : status, phase: Number.isInteger(phase) ? phase : 0, search: String(req.query.search || '') });
    const stats = await store.answerStats(rows.map(r => r.id));
    res.json(rows.map(r => {
      const s = stats[r.id] || {};
      return {
        ...clientView(r, base(req)),
        core: { answered: s.core_answered || 0, total: CORE_KEYS.length },
        checklist: { completed: s.checklist_completed || 0, total: CHECKLIST_STEMS.length },
        filled_by: s.filled_by || '',
      };
    }));
  }));

  app.post('/api/clients', team, guard(async (req, res) => {
    const b = req.body || {};
    const name = text(b.name, 'name', 200).trim();
    if (!name) throw new BadRequest('name is required');
    const slug = validSlug(b.slug ? b.slug : slugify(name));
    const state = validState(b.state);
    const token = b.token !== undefined ? String(b.token) : mintToken();
    if (!TOKEN_RE.test(token)) throw new BadRequest('token must be 8–64 lowercase letters or digits');
    const phase = b.phase === undefined ? 2 : parseInt(b.phase, 10);
    if (![1, 2, 3, 4].includes(phase)) throw new BadRequest('phase must be 1–4');
    const status = b.status === undefined ? 'active' : String(b.status);
    if (!STATUSES.includes(status)) throw new BadRequest(`status must be one of ${STATUSES.join(', ')}`);
    const contacts = validContacts(b.contacts);
    // The NPSA side of the Contacts tab: the standing team from intake-team.json,
    // plus whoever is named (the sales rep, usually). Pass npsa_contacts: [] to
    // register a client with no NPSA rows at all.
    const npsa = b.npsa_contacts === undefined
      ? NPSA_TEAM.map(c => validContact({ ...c, side: 'npsa' }, 'team'))
      : validContacts(b.npsa_contacts, 'npsa_contacts').map(c => ({ ...c, side: 'npsa' }));
    if (b.npsa_contacts !== undefined && b.include_team !== false) {
      for (const t of NPSA_TEAM) if (!npsa.some(c => c.email === t.email.toLowerCase())) npsa.push(validContact({ ...t, side: 'npsa' }, 'team'));
    }
    const row = await store.createClient({
      slug, name, state, token, phase, status,
      program_track: text(b.program_track, 'program_track'),
      drive_folder_id: text(b.drive_folder_id, 'drive_folder_id', 200).trim(),
      upload_folder_id: text(b.upload_folder_id, 'upload_folder_id', 200).trim(),
      asana_project_gid: text(b.asana_project_gid, 'asana_project_gid', 100).trim(),
      kickoff_date: validDate(b.kickoff_date, 'kickoff_date'),
      notes: text(b.notes, 'notes', 5000),
    });
    if (contacts.length) {
      if (!contacts.some(c => c.is_primary)) contacts[0].is_primary = true;
      await store.addContacts(row.id, contacts, `npsa:${req.actor}`);
    }
    if (npsa.length) await store.addContacts(row.id, npsa, `npsa:${req.actor}`);
    console.log(`[intake] client_create ${slug} by ${req.actor}`);
    res.status(201).json(clientView(await store.getClient(slug), base(req)));
  }));

  app.get('/api/clients/:slug', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const answers = await store.getAnswers(c.id);
    res.json({ ...clientView(c, base(req)), ...summarise(answers), filled_by: answers.get('_filled_by')?.value || '', status_line: answers.get('_status')?.value || '' });
  }));

  app.patch('/api/clients/:slug', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) { patch.name = text(b.name, 'name', 200).trim(); if (!patch.name) throw new BadRequest('name cannot be blank'); }
    if (b.state !== undefined) patch.state = validState(b.state);
    if (b.phase !== undefined) { patch.phase = parseInt(b.phase, 10); if (![1, 2, 3, 4].includes(patch.phase)) throw new BadRequest('phase must be 1–4'); }
    if (b.status !== undefined) {
      patch.status = String(b.status);
      if (!STATUSES.includes(patch.status)) throw new BadRequest(`status must be one of ${STATUSES.join(', ')}`);
      if (patch.status === 'submitted' && !c.submitted_at) patch.submitted_at = new Date();
    }
    for (const k of ['program_track', 'drive_folder_id', 'upload_folder_id', 'asana_project_gid']) if (b[k] !== undefined) patch[k] = text(b[k], k, 200).trim();
    if (b.notes !== undefined) patch.notes = text(b.notes, 'notes', 5000);
    if (b.kickoff_date !== undefined) patch.kickoff_date = validDate(b.kickoff_date, 'kickoff_date');
    const add = [
      ...validContacts(b.add_contacts),
      ...validContacts(b.add_npsa_contacts, 'add_npsa_contacts').map(x => ({ ...x, side: 'npsa' })),
    ];
    const remove = validEmails(b.remove_contact_emails, 'remove_contact_emails');
    if (!Object.keys(patch).length && !add.length && !remove.length) throw new BadRequest('Nothing to change');
    if (Object.keys(patch).length) await store.updateClient(c.slug, patch);
    if (remove.length) await store.removeContacts(c.id, remove);
    if (add.length) await store.addContacts(c.id, add, `npsa:${req.actor}`);
    console.log(`[intake] client_update ${c.slug} by ${req.actor} ${JSON.stringify(Object.keys(b))}`);
    res.json(clientView(await store.getClient(c.slug), base(req)));
  }));

  app.post('/api/clients/:slug/token', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const row = await store.rotateToken(c.slug, mintToken());
    console.log(`[intake] client_token_rotate ${c.slug} by ${req.actor}`);
    res.json(clientView(row, base(req)));
  }));

  app.get('/api/clients/:slug/answers', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const answers = await store.getAnswers(c.id);
    const section = String(req.query.section || '').toLowerCase();
    const includeEmpty = ['1', 'true'].includes(String(req.query.include_empty || ''));
    const rows = QUESTIONS
      .filter(q => !section || q.section.toLowerCase() === section)
      .map(q => { const a = answers.get(q.key); return { key: q.key, section: q.section, label: q.label, kind: q.kind, value: a?.value || '', updated_at: a?.updated_at || null, updated_by: a?.updated_by || '' }; })
      .filter(r => includeEmpty || r.value !== '');
    res.json({ slug: c.slug, name: c.name, count: rows.length, answers: rows });
  }));

  app.put('/api/clients/:slug/answers', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const rows = normaliseAnswers((req.body || {}).answers, { allowMeta: true });
    const by = text((req.body || {}).by, 'by', 60) || `seed:${req.actor}`;
    const n = await store.upsertAnswers(c.id, rows, by);
    console.log(`[intake] seed ${c.slug} by ${req.actor} ${n} key(s)`);
    res.json({ ok: true, slug: c.slug, written: n, keys: rows.map(r => r.key) });
  }));

  app.get('/api/clients/:slug/status', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    res.json(statusView(c, await store.getAnswers(c.id), base(req), await store.listUploads(c.id)));
  }));

  app.get('/api/clients/:slug/uploads', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const rows = await store.listUploads(c.id);
    res.json({ slug: c.slug, count: rows.length, uploads: rows.map(u => uploadView(u, c.slug)) });
  }));

  app.get('/api/clients/:slug/uploads/:id', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const id = parseInt(req.params.id, 10);
    const u = Number.isInteger(id) ? await store.getUpload(c.id, id) : null;
    if (!u) return res.status(404).json({ error: 'No such upload' });
    if (!u.content) return res.status(404).json({ error: 'This file is not stored here' + (u.drive_url ? `; see ${u.drive_url}` : '') });
    res.set('Content-Type', u.mime);
    res.set('Content-Disposition', `attachment; filename="${u.filename.replace(/["\r\n]/g, "_")}"`);
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(u.content));
  }));

  // ── Client ──

  app.get('/client/:slug', async (req, res) => {
    if (!store) return res.status(503).type('html').send(errorPage('The intake form is temporarily unavailable. Please try again shortly.'));
    const slug = String(req.params.slug || '');
    const c = SLUG_RE.test(slug) ? await store.getClient(slug) : null;
    if (!c) return res.status(404).type('html').send(errorPage(NOT_RECOGNISED));
    const t = healToken(req.query, req.originalUrl.split('?')[1]);
    if (!tokenMatches(t, c.token)) return res.status(404).type('html').send(errorPage(INVALID));
    const answers = await store.getAnswers(c.id);
    const html = renderPage && renderPage({
      client: c, stateConfig: stateConfig(c.state), apiBase, uploadBase, contacts: contactsView(c.contacts || []),
      existing: Object.fromEntries([...answers.values()].filter(a => a.value !== '').map(a => [a.key, a.value])),
    });
    if (!html) return res.status(503).type('html').send(errorPage('The intake form has not been deployed here yet.'));
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });

  app.put('/api/intake/:slug/answers', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const rows = normaliseAnswers((req.body || {}).answers);
    const existing = await store.getAnswers(c.id);
    const who = rows.find(r => r.key === '_filled_by')?.value || existing.get('_filled_by')?.value || '';
    const n = await store.upsertAnswers(c.id, rows, who ? `client:${who.slice(0, 80)}` : 'client', { clientActivity: true });
    res.json({ ok: true, saved: n });
  }));

  // Uploads. The page may post these straight to this origin rather than through
  // the Vercel passthrough (its functions cap bodies at 4.5 MB), so the route
  // answers CORS for the page's own origin — and only that one.
  const uploadCors = (req, res, next) => {
    const origin = req.get('origin');
    let allowed = false;
    if (origin && publicBase) { try { allowed = new URL(origin).origin === new URL(publicBase).origin; } catch { allowed = false; } }
    if (allowed) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'X-Intake-Token, Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
    next();
  };
  const uploadBody = express.raw({ type: 'multipart/form-data', limit: UPLOAD_MAX_BYTES + 1024 * 1024 });
  const uploadBodyError = (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'File too large — please keep uploads under 25 MB.' });
    return res.status(400).json({ error: 'Could not read the upload. Please try again.' });
  };

  app.options('/api/intake/:slug/upload', uploadCors);
  app.post('/api/intake/:slug/upload', uploadCors, uploadBody, uploadBodyError, guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    if (!Buffer.isBuffer(req.body)) throw new BadRequest('Send the file as multipart form data with fields "key" and "file".');
    let form;
    try { form = await new Response(req.body, { headers: { 'content-type': req.get('content-type') } }).formData(); }
    catch { throw new BadRequest('Could not read the upload. Please try again.'); }
    const key = String(form.get('key') || '');
    const file = form.get('file');
    const q = QUESTION_BY_KEY.get(key);
    if (!q || q.kind !== 'upload') throw new BadRequest(`"${key}" is not an upload field`);
    if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') throw new BadRequest('No file was attached.');
    const content = Buffer.from(await file.arrayBuffer());
    if (!content.length) throw new BadRequest('The file is empty.');
    if (content.length > UPLOAD_MAX_BYTES) { const e = new Error('File too large — please keep uploads under 25 MB.'); e.status = 413; throw e; }
    const mime = sniffUploadType(content);
    if (!mime) throw new BadRequest('Unsupported file type — please upload a PDF, JPG, or PNG.');
    const filename = safeFilename(file.name);
    const existing = await store.getAnswers(c.id);
    const who = existing.get('_filled_by')?.value || '';
    const by = who ? `client:${who.slice(0, 80)}` : 'client';

    const row = await store.addUpload(c.id, { key, filename, mime, size_bytes: content.length, content, uploaded_by: by });

    let driveUrl = '';
    if (drive) {
      try {
        const d = await drive.upload({ folderId: c.upload_folder_id, filename, mime, content });
        await store.setUploadDrive(row.id, { drive_file_id: d.id, drive_url: d.url });
        driveUrl = d.url;
      } catch (err) {
        console.warn(`[intake] drive mirror failed for ${c.slug}/${key}: ${err.message}`);
      }
    }
    const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium' }).format(new Date());
    const note = `${filename} (uploaded ${when})${driveUrl ? `  ${driveUrl}` : ''}`;
    await store.upsertAnswers(c.id, [{ key, value: note }], by, { clientActivity: true });
    console.log(`[intake] upload ${c.slug} ${key} ${filename} ${content.length}b${driveUrl ? ' → drive' : ''}`);
    res.json({ ok: true, id: row.id, key, filename, mime, size_bytes: content.length, drive_url: driveUrl || null });
  }));

  // The Contacts tab. The client sees the NPSA team and their own people, and can
  // add or remove their own; the NPSA rows are the team's to manage.
  app.get('/api/intake/:slug/contacts', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    res.json(contactsView(c.contacts || []));
  }));

  app.post('/api/intake/:slug/contacts', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw new BadRequest('Please give the person\'s name.');
    let contact;
    try { contact = validContact({ name: b.name, email: b.email, role: b.role, phone: b.phone, side: 'client' }, 'contact'); }
    catch { throw new BadRequest('Please give a valid email address.'); }
    if ((c.contacts || []).some(x => x.email === contact.email && x.side === 'npsa')) throw new BadRequest('That address belongs to the NPSA team.');
    const existing = await store.getAnswers(c.id);
    const who = existing.get('_filled_by')?.value || '';
    await store.addContacts(c.id, [contact], who ? `client:${who.slice(0, 80)}` : 'client');
    await store.upsertAnswers(c.id, [], 'client', { clientActivity: true }).catch(() => {});
    await store.updateClient(c.slug, {}).catch(() => {});
    const fresh = await store.getClient(c.slug);
    console.log(`[intake] contact added ${c.slug} ${contact.email}`);
    res.json({ ok: true, ...contactsView(fresh.contacts || []) });
  }));

  app.delete('/api/intake/:slug/contacts', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const email = String(req.query.email || (req.body || {}).email || '').trim().toLowerCase();
    const row = (c.contacts || []).find(x => x.email === email);
    if (!row) return res.status(404).json({ error: 'No such contact' });
    if (row.side === 'npsa') throw new BadRequest('The NPSA team is managed by NPSA.');
    await store.removeContacts(c.id, [email]);
    const fresh = await store.getClient(c.slug);
    console.log(`[intake] contact removed ${c.slug} ${email}`);
    res.json({ ok: true, ...contactsView(fresh.contacts || []) });
  }));

  app.post('/api/intake/:slug/complete', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const existing = await store.getAnswers(c.id);
    const who = existing.get('_filled_by')?.value || 'the client';
    const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    const stamp = `Submitted ${when} CT by ${who}`;
    await store.upsertAnswers(c.id, [{ key: '_status', value: stamp }], 'client', { clientActivity: true });
    if (c.status === 'active') await store.updateClient(c.slug, { status: 'submitted', submitted_at: new Date() });
    console.log(`[intake] complete ${c.slug} (${who})`);
    res.json({ ok: true, status: stamp });
  }));
}
