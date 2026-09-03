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
import { readFileSync } from 'fs';
import { STATE_REFERENCE } from './nsgp-deadlines.js';
import { splitKeys, keyMatches, fingerprint } from './mcp.js';

// ── Catalog ───────────────────────────────────────────────────────────────────

const CATALOG = JSON.parse(readFileSync(new URL('./intake-questions.json', import.meta.url), 'utf8'));
const STATE_CONFIG = JSON.parse(readFileSync(new URL('./intake-state-config.json', import.meta.url), 'utf8'));

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

function validContacts(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BadRequest('contacts must be an array');
  return list.map((c, i) => {
    const email = String(c?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequest(`contacts[${i}].email is not an email address`);
    return { name: String(c.name || '').trim(), email, role: String(c.role || '').trim(), is_primary: Boolean(c.is_primary) };
  });
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

function statusView(client, answers, base) {
  const val = k => answers.get(k)?.value || '';
  const sections = SECTIONS.map(section => {
    const keys = QUESTIONS.filter(q => q.section === section && q.kind !== 'meta');
    return { section, answered: keys.filter(q => val(q.key) !== '').length, total: keys.length };
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
    core: s.core, sections, checklist: { ...s.checklist, items },
    uploads: [],
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
    CREATE TABLE IF NOT EXISTS intake_answers (
      client_id   INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (client_id, key)
    );
  `);
}

const CLIENT_COLS = `id, slug, name, state, token, phase, status, program_track, drive_folder_id, upload_folder_id,
  asana_project_gid, to_char(kickoff_date, 'YYYY-MM-DD') AS kickoff_date, notes, created_at, updated_at,
  submitted_at, last_client_activity_at`;

/** Postgres-backed store. Every method takes and returns plain objects. */
export function createIntakeStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const contactsFor = async id => (await pool.query(
    'SELECT id, name, email, role, is_primary, added_by, created_at FROM client_contacts WHERE client_id=$1 ORDER BY is_primary DESC, id', [id])).rows;
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
          `INSERT INTO client_contacts (client_id, name, email, role, is_primary, added_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (client_id, email) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE client_contacts.name END,
             role = CASE WHEN EXCLUDED.role <> '' THEN EXCLUDED.role ELSE client_contacts.role END,
             is_primary = client_contacts.is_primary OR EXCLUDED.is_primary`,
          [clientId, c.name, c.email, c.role, c.is_primary, addedBy]);
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
  };
}

/** In-memory store with the same surface, for the smoke test. */
export function createMemoryStore() {
  const clients = []; const contacts = []; const answers = new Map(); let nextId = 1; let nextContactId = 1;
  const now = () => new Date();
  const find = slug => clients.find(c => c.slug === slug) || null;
  const view = c => c && { ...c, contacts: contacts.filter(x => x.client_id === c.id).sort((a, b) => (b.is_primary - a.is_primary) || (a.id - b.id)) };
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
        if (cur) { if (x.name) cur.name = x.name; if (x.role) cur.role = x.role; cur.is_primary = cur.is_primary || x.is_primary; }
        else contacts.push({ id: nextContactId++, client_id: clientId, ...x, added_by: addedBy, created_at: now() });
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

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerIntake(app, { store, internalKey, publicBase, renderPage } = {}) {
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
    const add = validContacts(b.add_contacts);
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
    res.json(statusView(c, await store.getAnswers(c.id), base(req)));
  }));

  // ── Client ──

  app.get('/client/:slug', async (req, res) => {
    if (!store) return res.status(503).type('html').send(errorPage('The intake form is temporarily unavailable. Please try again shortly.'));
    const slug = String(req.params.slug || '');
    const c = SLUG_RE.test(slug) ? await store.getClient(slug) : null;
    if (!c) return res.status(404).type('html').send(errorPage(NOT_RECOGNISED));
    const t = healToken(req.query, req.originalUrl.split('?')[1]);
    if (!tokenMatches(t, c.token)) return res.status(404).type('html').send(errorPage(INVALID));
    if (!renderPage) return res.status(503).type('html').send(errorPage('The intake form has not been deployed here yet.'));
    const answers = await store.getAnswers(c.id);
    res.set('Cache-Control', 'no-store').type('html').send(renderPage({
      client: c, stateConfig: stateConfig(c.state),
      existing: Object.fromEntries([...answers.values()].filter(a => a.value !== '').map(a => [a.key, a.value])),
    }));
  });

  app.put('/api/intake/:slug/answers', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const rows = normaliseAnswers((req.body || {}).answers);
    const existing = await store.getAnswers(c.id);
    const who = rows.find(r => r.key === '_filled_by')?.value || existing.get('_filled_by')?.value || '';
    const n = await store.upsertAnswers(c.id, rows, who ? `client:${who.slice(0, 80)}` : 'client', { clientActivity: true });
    res.json({ ok: true, saved: n });
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
