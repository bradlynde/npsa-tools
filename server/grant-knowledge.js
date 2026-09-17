// Grant knowledge: what NPSA knows about NSGP and the state-funded programs, per
// jurisdiction, editable by the team, with every change kept.
//
// Until this module the knowledge lived in a Drive folder of YAML files, and the
// repo carried three extractions of it (nsgp-data.json, intake-state-config.json,
// intake-documents.json) that each went stale on their own schedule. One fact about
// Texas took three file edits and a deploy to correct. Here a fact is a row: anyone
// on the team can change it in the toolbox, Claude can change it through the MCP,
// and either way the old value, the new value and the person are written down.
//
// The model is a typed record store rather than a table per concept:
//
//   gk_records    one row per record. `kind` says what it is (grant-knowledge-kinds.js
//                 holds each kind's schema), `data` holds its fields, and the columns
//                 around it carry what every record needs: where it hangs, whether a
//                 person has verified it, where it came from, its version.
//   gk_revisions  append-only. Every write, whatever the kind, lands exactly one row
//                 with full before/after snapshots, so history, diff and revert are
//                 written once instead of once per table. Nothing here updates or
//                 deletes a revision.
//
// Trust is per record. A record is `unverified` until a person verifies it; an edit
// to a verified record flags just the fields that moved (`unverified_fields`) rather
// than throwing away the verification of everything else. `stale` is never stored:
// it is what a verified record becomes, at read time, once the verification is old.
// Claude's research always lands unverified and must say where it came from.
//
// Writes carry the version they were made against. A write against an old version is
// refused with the current record (409), so two people editing the same state cannot
// silently overwrite each other.
//
// Storage sits behind the same small store interface the intake module uses, so the
// routes run against an in-memory twin with no database (scripts/gk-smoke.mjs).
//
//   ensureGrantKnowledgeSchema(pool)                         // at boot
//   registerGrantKnowledge(app, { store, internalKey })      // before the /api 404

import { teamGate } from './intake.js';
import {
  JURISDICTIONS, JURISDICTION_CODES, jurisdictionKind, KINDS, PARENT_KINDS,
  parseData, titleFor, searchTextFor, sortDateFor, slugKey,
} from './grant-knowledge-kinds.js';

export const STALE_AFTER_DAYS = 365;
const DEFAULT_TZ = 'America/New_York';
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const URL_RE = /^https?:\/\/\S+$/i;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message, extra) => new HttpError(400, message, extra);

// ── Time ──────────────────────────────────────────────────────────────────────

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** The instant a wall-clock date and time names in a zone. No time means the end of that day there. */
export function zonedInstant(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time ? [...time.split(':').map(Number), 0] : [23, 59, 59];
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  // Two passes: the offset at the guess can differ from the offset at the answer
  // on the two days a year the clocks move.
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz);
  return new Date(t);
}

const iso = v => (v ? new Date(v).toISOString() : null);

// ── Views ─────────────────────────────────────────────────────────────────────

function isStale(r, now) {
  if (r.status !== 'verified' || !r.verified_at) return false;
  // What happened does not go stale: a deadline that has passed, a cycle that closed.
  if (r.kind === 'deadline' && r.data.due_date && r.data.due_date < now.toISOString().slice(0, 10)) return false;
  if (r.kind === 'cycle' && ['closed', 'awarded'].includes(r.data.status)) return false;
  return now - new Date(r.verified_at) > STALE_AFTER_DAYS * 86400000;
}

export function recordView(r, now = new Date()) {
  return {
    id: r.id, jurisdiction: r.jurisdiction, kind: r.kind, parent_id: r.parent_id ?? null, key: r.key,
    title: titleFor(r.kind, r.key, r.data),
    data: r.data,
    status: r.status,
    effective_status: isStale(r, now) ? 'stale' : r.status,
    unverified_fields: r.unverified_fields || [],
    verified_at: iso(r.verified_at), verified_by: r.verified_by || '',
    source_url: r.source_url || '', origin: r.origin, version: r.version, sort_order: r.sort_order || 0,
    created_at: iso(r.created_at), created_by: r.created_by || '',
    updated_at: iso(r.updated_at), updated_by: r.updated_by || '',
    archived_at: iso(r.archived_at), archived_by: r.archived_by || '',
  };
}

// What a revision keeps of a record: everything a revert has to put back.
function snapshot(r) {
  return {
    id: r.id, jurisdiction: r.jurisdiction, kind: r.kind, parent_id: r.parent_id ?? null, key: r.key,
    data: r.data, status: r.status, unverified_fields: r.unverified_fields || [],
    verified_at: iso(r.verified_at), verified_by: r.verified_by || '',
    source_url: r.source_url || '', origin: r.origin, sort_order: r.sort_order || 0,
    version: r.version, archived_at: iso(r.archived_at), archived_by: r.archived_by || '',
  };
}

function revisionView(v) {
  return {
    id: v.id, record_id: v.record_id, jurisdiction: v.jurisdiction, kind: v.kind, action: v.action,
    title: titleFor(v.kind, (v.after || v.before || {}).key || '', (v.after || v.before || {}).data),
    version_from: v.version_from ?? null, version_to: v.version_to,
    changed_fields: v.changed_fields || [], before: v.before || null, after: v.after,
    actor: v.actor, actor_kind: v.actor_kind, reason: v.reason || '',
    reverted_revision_id: v.reverted_revision_id ?? null, created_at: iso(v.created_at),
  };
}

// ── Assembly: records → what a page or a tool reads ───────────────────────────

const bySort = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);

/** Drops archived records and anything hanging under one, so an archived program takes its requirements with it. */
export function activeTree(records) {
  const byId = new Map(records.map(r => [r.id, r]));
  const alive = r => {
    for (let cur = r, hops = 0; cur && hops < 6; cur = cur.parent_id ? byId.get(cur.parent_id) : null, hops++) {
      if (cur.archived_at) return false;
      if (cur.parent_id && !byId.has(cur.parent_id)) return false;
    }
    return true;
  };
  return records.filter(alive);
}

function deadlineInstant(d, fallbackTz) {
  return zonedInstant(d.data.due_date, d.data.due_time || null, d.data.tz || fallbackTz || DEFAULT_TZ);
}

function deadlineLine(d, cycle, program, fallbackTz, now) {
  const at = deadlineInstant(d, fallbackTz);
  return {
    record_id: d.id, program: program.key, program_name: program.data.name, cycle: cycle.key,
    label: d.data.label, due_date: d.data.due_date, due_time: d.data.due_time || null,
    tz: d.data.tz || fallbackTz || DEFAULT_TZ, instant: at.toISOString(),
    days_away: Math.ceil((at - now) / 86400000),
    deadline_kind: d.data.deadline_kind || 'sub_applicant', confidence: d.data.confidence || 'confirmed',
    status: d.status,
  };
}

/**
 * Where a jurisdiction is in its year: `open` (a deadline ahead and the window is
 * open), `soon` (a deadline or an opening ahead), `closed` (only past deadlines),
 * `unknown` (no dates recorded).
 */
function cycleState(programs, fallbackTz, now) {
  const today = now.toISOString().slice(0, 10);
  const soonBy = new Date(now.getTime() + 60 * 86400000).toISOString().slice(0, 10);
  let ahead = null, anyPast = false, opening = false;
  for (const p of programs) {
    if (['dormant', 'dead'].includes(p.data.status)) continue;
    for (const c of p.cycles) {
      if (c.data.open_date && c.data.open_date > today && c.data.open_date <= soonBy) opening = true;
      for (const d of c.deadlines) {
        const line = deadlineLine(d, c, p, fallbackTz, now);
        if (new Date(line.instant) <= now) { anyPast = true; continue; }
        const open = c.data.status === 'open' || (c.data.open_date && c.data.open_date <= today);
        if (!ahead || line.instant < ahead.instant) ahead = { ...line, open: Boolean(open) };
      }
    }
  }
  if (ahead) return { state: ahead.open ? 'open' : 'soon', next_deadline: ahead };
  if (opening) return { state: 'soon', next_deadline: null };
  return { state: anyPast ? 'closed' : 'unknown', next_deadline: null };
}

function freshness(views) {
  const out = { records: views.length, verified: 0, unverified: 0, stale: 0, fields_to_confirm: 0 };
  for (const v of views) {
    out[v.effective_status]++;
    out.fields_to_confirm += v.unverified_fields.length;
  }
  return out;
}

/**
 * One jurisdiction's records as a document: programs with their requirements,
 * cycles and deadlines, then the contacts, notes and sources that belong to the
 * jurisdiction as a whole. `federal` is the US baseline program's requirements;
 * a federal program in a state shows them first, flagged, with the state's own after.
 */
export function assemble(code, records, { now = new Date(), federal = [] } = {}) {
  const live = activeTree(records).filter(r => r.jurisdiction === code);
  const views = live.map(r => recordView(r, now));
  const childrenOf = (id, kind) => views.filter(v => v.parent_id === id && v.kind === kind).sort(bySort);
  const jurisdiction = views.find(v => v.kind === 'jurisdiction') || null;
  const fallbackTz = jurisdiction?.data.default_tz || DEFAULT_TZ;

  const programs = views.filter(v => v.kind === 'program').sort(bySort).map(p => {
    const own = childrenOf(p.id, 'requirement').map(r => ({ ...r, baseline: 'state' }));
    const cycles = childrenOf(p.id, 'cycle')
      .sort((a, b) => (b.data.fiscal_year - a.data.fiscal_year) || bySort(a, b))
      .map(c => ({ ...c, deadlines: childrenOf(c.id, 'deadline').sort((a, b) => (a.data.stage_order ?? 0) - (b.data.stage_order ?? 0) || a.data.due_date.localeCompare(b.data.due_date)) }));
    return { ...p, requirements: own, cycles, contacts: childrenOf(p.id, 'contact'), notes: childrenOf(p.id, 'note'), sources: childrenOf(p.id, 'source') };
  });

  // Requirements a program takes from elsewhere: a sibling it inherits from
  // (NSGP-UA from NSGP-S), and, for a federal program in a state, the US baseline.
  for (const p of programs) {
    const inherited = [];
    if (code !== 'US' && p.data.type === 'federal') inherited.push(...federal.map(r => ({ ...r, baseline: 'federal' })));
    const from = p.data.inherits_from && programs.find(x => x.key === p.data.inherits_from && x.id !== p.id);
    if (from) inherited.push(...from.requirements.map(r => ({ ...r, baseline: 'state', inherited_from: from.key })));
    p.inherited_requirements = inherited;
  }

  const loose = kind => views.filter(v => v.kind === kind && !v.parent_id).sort(bySort);
  const notes = loose('note');
  const cs = cycleState(programs, fallbackTz, now);
  return {
    code, name: JURISDICTIONS[code], jurisdiction_kind: jurisdictionKind(code),
    jurisdiction, programs, contacts: loose('contact'), notes, sources: loose('source'),
    cycle_state: cs.state, next_deadline: cs.next_deadline,
    freshness: freshness(views),
    open_questions: views.filter(v => v.kind === 'note' && v.data.category === 'open_question' && !v.data.resolved).length,
  };
}

/** The US baseline program's requirements, as views, for assemble()'s `federal`. */
export function federalBaseline(records, now = new Date()) {
  const live = activeTree(records).filter(r => r.jurisdiction === 'US');
  const base = live.filter(r => r.kind === 'program').sort(bySort)[0];
  if (!base) return [];
  return live.filter(r => r.kind === 'requirement' && r.parent_id === base.id).sort(bySort).map(r => recordView(r, now));
}

/** A program's full checklist: inherited first, then its own; hard gates and long lead times lead each group. */
export function checklist(program) {
  const order = (a, b) => (Number(Boolean(b.data.hard_gate)) - Number(Boolean(a.data.hard_gate)))
    || ((b.data.lead_time_days || 0) - (a.data.lead_time_days || 0)) || bySort(a, b);
  const line = r => ({
    record_id: r.id, key: r.key, req_type: r.data.req_type, label: r.data.label, owner: r.data.owner || 'client',
    hard_gate: Boolean(r.data.hard_gate), lead_time_days: r.data.lead_time_days ?? null, format: r.data.format || '',
    phase: r.data.phase || (r.data.req_type === 'registration' ? 'registration' : 'application'),
    notes: r.data.notes || '', url: r.data.url || '', baseline: r.baseline, inherited_from: r.inherited_from || null,
    status: r.effective_status, unverified_fields: r.unverified_fields,
  });
  const all = [...program.inherited_requirements, ...program.requirements];
  return {
    registration: all.filter(r => r.data.req_type === 'registration').sort(order).map(line),
    documents: all.filter(r => r.data.req_type === 'document').sort(order).map(line),
  };
}

function overviewRow(doc) {
  return {
    code: doc.code, name: doc.name, jurisdiction_kind: doc.jurisdiction_kind,
    saa: doc.jurisdiction?.data.saa || '', saa_short: doc.jurisdiction?.data.saa_short || '',
    programs: doc.programs.map(p => ({ key: p.key, name: p.data.name, type: p.data.type, status: p.data.status || 'active' })),
    has_state_program: doc.programs.some(p => p.data.type === 'state' && !['dormant', 'dead'].includes(p.data.status)),
    cycle_state: doc.cycle_state, next_deadline: doc.next_deadline,
    freshness: doc.freshness, open_questions: doc.open_questions,
  };
}

function attention(records, { now, days, code }) {
  const live = activeTree(records).filter(r => !code || r.jurisdiction === code);
  const byId = new Map(live.map(r => [r.id, r]));
  const horizon = new Date(now.getTime() + days * 86400000);
  const out = { unverified: [], stale: [], deadlines_soon: [], open_questions: [], missing: [] };
  const brief = v => ({ record_id: v.id, jurisdiction: v.jurisdiction, kind: v.kind, title: v.title, version: v.version, origin: v.origin, source_url: v.source_url, updated_by: v.updated_by, updated_at: v.updated_at });
  const tzOf = new Map(live.filter(r => r.kind === 'jurisdiction').map(r => [r.jurisdiction, r.data.default_tz]));

  for (const r of live) {
    const v = recordView(r, now);
    if (v.effective_status === 'stale') out.stale.push({ ...brief(v), verified_at: v.verified_at });
    else if (v.status === 'unverified') out.unverified.push({ ...brief(v), fields: [] });
    else if (v.unverified_fields.length) out.unverified.push({ ...brief(v), fields: v.unverified_fields });
    if (r.kind === 'note' && r.data.category === 'open_question' && !r.data.resolved) out.open_questions.push(brief(v));
    if (r.kind === 'deadline') {
      const cycle = byId.get(r.parent_id), program = cycle && byId.get(cycle.parent_id);
      if (!program || ['dormant', 'dead'].includes(program.data.status)) continue;
      const line = deadlineLine(r, cycle, program, tzOf.get(r.jurisdiction), now);
      const at = new Date(line.instant);
      if (at > now && at <= horizon) out.deadlines_soon.push({ jurisdiction: r.jurisdiction, ...line });
    }
  }
  out.deadlines_soon.sort((a, b) => a.instant.localeCompare(b.instant));

  // Holes worth filling: a jurisdiction nobody has started, an active program with
  // no cycle on record, a jurisdiction with no contact at all.
  for (const c of (code ? [code] : JURISDICTION_CODES)) {
    const mine = live.filter(r => r.jurisdiction === c);
    if (!mine.some(r => r.kind === 'jurisdiction')) { out.missing.push({ jurisdiction: c, what: 'no jurisdiction record' }); continue; }
    if (c !== 'US' && !mine.some(r => r.kind === 'contact')) out.missing.push({ jurisdiction: c, what: 'no contact on record' });
    for (const p of mine.filter(r => r.kind === 'program' && !['dormant', 'dead'].includes(r.data.status))) {
      if (!mine.some(r => r.kind === 'cycle' && r.parent_id === p.id)) out.missing.push({ jurisdiction: c, record_id: p.id, what: `${p.key}: no cycle on record` });
    }
  }
  return { days, counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), ...out };
}

// ── Schema ────────────────────────────────────────────────────────────────────

export async function ensureGrantKnowledgeSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gk_records (
      id            SERIAL PRIMARY KEY,
      jurisdiction  TEXT NOT NULL,
      kind          TEXT NOT NULL,
      parent_id     INT REFERENCES gk_records(id),
      key           TEXT NOT NULL,
      data          JSONB NOT NULL DEFAULT '{}',
      sort_date     DATE,
      sort_order    INT NOT NULL DEFAULT 0,
      search_text   TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'unverified',
      unverified_fields TEXT[] NOT NULL DEFAULT '{}',
      verified_at   TIMESTAMPTZ,
      verified_by   TEXT NOT NULL DEFAULT '',
      source_url    TEXT NOT NULL DEFAULT '',
      origin        TEXT NOT NULL DEFAULT 'manual',
      import_key    TEXT,
      version       INT NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      created_by    TEXT NOT NULL DEFAULT '',
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_by    TEXT NOT NULL DEFAULT '',
      archived_at   TIMESTAMPTZ,
      archived_by   TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gk_records_natural ON gk_records (jurisdiction, kind, COALESCE(parent_id, 0), key);
    CREATE UNIQUE INDEX IF NOT EXISTS gk_records_import ON gk_records (import_key) WHERE import_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS gk_records_jurisdiction ON gk_records (jurisdiction) WHERE archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS gk_revisions (
      id             SERIAL PRIMARY KEY,
      record_id      INT NOT NULL REFERENCES gk_records(id),
      jurisdiction   TEXT NOT NULL,
      kind           TEXT NOT NULL,
      action         TEXT NOT NULL,
      version_from   INT,
      version_to     INT NOT NULL,
      before         JSONB,
      after          JSONB NOT NULL,
      changed_fields TEXT[] NOT NULL DEFAULT '{}',
      actor          TEXT NOT NULL,
      actor_kind     TEXT NOT NULL,
      reason         TEXT NOT NULL DEFAULT '',
      reverted_revision_id INT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gk_revisions_record ON gk_revisions (record_id, id DESC);
    CREATE INDEX IF NOT EXISTS gk_revisions_jurisdiction ON gk_revisions (jurisdiction, id DESC);
  `);
}

// ── Stores ────────────────────────────────────────────────────────────────────
//
// Both stores do the same two writes. createRecord inserts a record and its first
// revision; updateRecord moves a record from one version to the next and writes the
// revision for that move, or throws 409 if the record is no longer at the version
// the caller read. There is no other way to change a record, so there is no way to
// change one without a revision.

const MUTABLE = ['key', 'data', 'sort_date', 'sort_order', 'search_text', 'status', 'unverified_fields', 'verified_at', 'verified_by', 'source_url', 'archived_at', 'archived_by'];

function likeTerms(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
}

export function createKnowledgeStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const revisionSql = `INSERT INTO gk_revisions (record_id, jurisdiction, kind, action, version_from, version_to, before, after, changed_fields, actor, actor_kind, reason, reverted_revision_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`;
  const revisionParams = (row, rev) => [row.id, row.jurisdiction, row.kind, rev.action, rev.before ? rev.before.version : null, row.version,
    rev.before ? JSON.stringify(rev.before) : null, JSON.stringify(snapshot(row)), rev.changed_fields || [], rev.actor, rev.actor_kind, rev.reason || '', rev.reverted_revision_id ?? null];

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  return {
    getRecord: id => one('SELECT * FROM gk_records WHERE id = $1', [id]),
    findNatural: (jurisdiction, kind, parentId, key) => one(
      'SELECT * FROM gk_records WHERE jurisdiction = $1 AND kind = $2 AND COALESCE(parent_id, 0) = $3 AND key = $4', [jurisdiction, kind, parentId || 0, key]),
    findImportKey: importKey => one('SELECT * FROM gk_records WHERE import_key = $1', [importKey]),
    async listRecords({ jurisdiction, includeArchived = false } = {}) {
      const { rows } = await pool.query(
        `SELECT * FROM gk_records WHERE ($1::text IS NULL OR jurisdiction = $1) AND ($2 OR archived_at IS NULL) ORDER BY id`,
        [jurisdiction || null, includeArchived]);
      return rows;
    },
    async createRecord(rec, rev) {
      try {
        return await inTransaction(async client => {
          const { rows: [row] } = await client.query(
            `INSERT INTO gk_records (jurisdiction, kind, parent_id, key, data, sort_date, sort_order, search_text, status, unverified_fields,
               verified_at, verified_by, source_url, origin, import_key, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
            [rec.jurisdiction, rec.kind, rec.parent_id || null, rec.key, JSON.stringify(rec.data), rec.sort_date, rec.sort_order || 0, rec.search_text,
              rec.status, rec.unverified_fields || [], rec.verified_at || null, rec.verified_by || '', rec.source_url || '', rec.origin, rec.import_key || null, rev.actor]);
          await client.query(revisionSql, revisionParams(row, rev));
          return row;
        });
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'A record with that key already exists here');
        throw err;
      }
    },
    async updateRecord(id, expectedVersion, fields, rev) {
      return inTransaction(async client => {
        const sets = MUTABLE.map((f, i) => `${f} = $${i + 4}${f === 'data' ? '::jsonb' : ''}`);
        const { rows: [row] } = await client.query(
          `UPDATE gk_records SET ${sets.join(', ')}, version = version + 1, updated_at = NOW(), updated_by = $3 WHERE id = $1 AND version = $2 RETURNING *`,
          [id, expectedVersion, rev.actor, ...MUTABLE.map(f => (f === 'data' ? JSON.stringify(fields.data) : fields[f]))]);
        if (!row) throw new HttpError(409, 'This record changed while you were editing it');
        await client.query(revisionSql, revisionParams(row, rev));
        return row;
      });
    },
    async listRevisions({ recordId, jurisdiction, limit = 50, before } = {}) {
      const { rows } = await pool.query(
        `SELECT * FROM gk_revisions WHERE ($1::int IS NULL OR record_id = $1) AND ($2::text IS NULL OR jurisdiction = $2) AND ($3::int IS NULL OR id < $3)
         ORDER BY id DESC LIMIT $4`, [recordId || null, jurisdiction || null, before || null, limit]);
      return rows;
    },
    getRevision: id => one('SELECT * FROM gk_revisions WHERE id = $1', [id]),
    async search(q, { jurisdiction, kinds } = {}) {
      const terms = likeTerms(q);
      if (!terms.length) return [];
      const params = [jurisdiction || null, kinds?.length ? kinds : null];
      const where = terms.map(t => { params.push(`%${t.replace(/[\\%_]/g, '\\$&')}%`); return `search_text LIKE $${params.length}`; });
      const { rows } = await pool.query(
        `SELECT * FROM gk_records WHERE archived_at IS NULL AND ($1::text IS NULL OR jurisdiction = $1) AND ($2::text[] IS NULL OR kind = ANY($2)) AND ${where.join(' AND ')}
         ORDER BY jurisdiction, id LIMIT 60`, params);
      return rows;
    },
  };
}

export function createMemoryKnowledgeStore({ now = () => new Date() } = {}) {
  const records = [], revisions = [];
  let nextId = 1, nextRevision = 1;
  const copy = v => JSON.parse(JSON.stringify(v));
  const pushRevision = (row, rev) => revisions.push({
    id: nextRevision++, record_id: row.id, jurisdiction: row.jurisdiction, kind: row.kind, action: rev.action,
    version_from: rev.before ? rev.before.version : null, version_to: row.version, before: rev.before ? copy(rev.before) : null, after: copy(snapshot(row)),
    changed_fields: rev.changed_fields || [], actor: rev.actor, actor_kind: rev.actor_kind, reason: rev.reason || '',
    reverted_revision_id: rev.reverted_revision_id ?? null, created_at: now().toISOString(),
  });
  return {
    _records: records, _revisions: revisions,
    async getRecord(id) { const r = records.find(x => x.id === id); return r ? copy(r) : null; },
    async findNatural(jurisdiction, kind, parentId, key) {
      const r = records.find(x => x.jurisdiction === jurisdiction && x.kind === kind && (x.parent_id || 0) === (parentId || 0) && x.key === key);
      return r ? copy(r) : null;
    },
    async findImportKey(importKey) { const r = records.find(x => x.import_key === importKey); return r ? copy(r) : null; },
    async listRecords({ jurisdiction, includeArchived = false } = {}) {
      return copy(records.filter(r => (!jurisdiction || r.jurisdiction === jurisdiction) && (includeArchived || !r.archived_at)));
    },
    async createRecord(rec, rev) {
      if (records.some(x => x.jurisdiction === rec.jurisdiction && x.kind === rec.kind && (x.parent_id || 0) === (rec.parent_id || 0) && x.key === rec.key)
        || (rec.import_key && records.some(x => x.import_key === rec.import_key))) throw new HttpError(409, 'A record with that key already exists here');
      const at = now().toISOString();
      const row = {
        id: nextId++, jurisdiction: rec.jurisdiction, kind: rec.kind, parent_id: rec.parent_id || null, key: rec.key, data: copy(rec.data),
        sort_date: rec.sort_date || null, sort_order: rec.sort_order || 0, search_text: rec.search_text, status: rec.status,
        unverified_fields: rec.unverified_fields || [], verified_at: rec.verified_at || null, verified_by: rec.verified_by || '',
        source_url: rec.source_url || '', origin: rec.origin, import_key: rec.import_key || null, version: 1,
        created_at: at, created_by: rev.actor, updated_at: at, updated_by: rev.actor, archived_at: null, archived_by: '',
      };
      records.push(row);
      pushRevision(row, rev);
      return copy(row);
    },
    async updateRecord(id, expectedVersion, fields, rev) {
      const row = records.find(x => x.id === id);
      if (!row || row.version !== expectedVersion) throw new HttpError(409, 'This record changed while you were editing it');
      for (const f of MUTABLE) row[f] = f === 'data' ? copy(fields.data) : fields[f];
      row.version += 1; row.updated_at = now().toISOString(); row.updated_by = rev.actor;
      pushRevision(row, rev);
      return copy(row);
    },
    async listRevisions({ recordId, jurisdiction, limit = 50, before } = {}) {
      return copy(revisions.filter(v => (!recordId || v.record_id === recordId) && (!jurisdiction || v.jurisdiction === jurisdiction) && (!before || v.id < before))
        .sort((a, b) => b.id - a.id).slice(0, limit));
    },
    async getRevision(id) { const v = revisions.find(x => x.id === id); return v ? copy(v) : null; },
    async search(q, { jurisdiction, kinds } = {}) {
      const terms = likeTerms(q);
      if (!terms.length) return [];
      return copy(records.filter(r => !r.archived_at && (!jurisdiction || r.jurisdiction === jurisdiction) && (!kinds?.length || kinds.includes(r.kind))
        && terms.every(t => r.search_text.includes(t))).slice(0, 60));
    },
  };
}

// ── Writes: how a request becomes the next version of a record ────────────────

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function validJurisdiction(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!JURISDICTIONS[c]) throw bad('jurisdiction must be a USPS state code, DC, PR, GU, VI, AS, MP, or US');
  return c;
}

function validSourceUrl(v) {
  const s = String(v ?? '').trim();
  if (s && !URL_RE.test(s)) throw bad('source_url must be an http(s) URL');
  return s.slice(0, 1000);
}

function validVersion(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad('version is required: send the version of the record you read');
  return n;
}

/** null means "clear this field", so a merge can remove a value as well as set one. */
function mergeData(current, patch) {
  if (patch === undefined) return { ...current };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('data must be an object');
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}

const derived = (kind, key, data) => ({ search_text: searchTextFor(kind, key, data), sort_date: sortDateFor(kind, data) });

const ORIGINS_BY_ACTOR = { mcp: ['mcp', 'research'], import: ['import'] };
function originFor(actorKind, asked) {
  const allowed = ORIGINS_BY_ACTOR[actorKind] || ['manual'];
  return allowed.includes(asked) ? asked : allowed[0];
}

// Claude's writes have to be traceable: a link, or a sentence saying the person
// stated it from their own experience.
function requireProvenance(actorKind, sourceUrl, reason) {
  if (actorKind === 'mcp' && !sourceUrl && !String(reason || '').trim()) {
    throw bad('A write made through Claude needs a source_url, or a reason saying the user stated this from direct experience');
  }
}

export function registerGrantKnowledge(app, { store, internalKey, now = () => new Date() } = {}) {
  const team = teamGate({ internalKey });
  const guard = fn => async (req, res) => {
    if (!store) return res.status(503).json({ error: 'Storage not configured' });
    try { await fn(req, res); }
    catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('grant knowledge route error:', err);
      res.status(status).json({ error: err.message, ...(err.extra || {}) });
    }
  };
  const ctx = req => ({ actor: req.actor || 'unknown', actor_kind: req.actorKind || 'key' });
  const parse = (kind, data) => { try { return parseData(kind, data); } catch (err) { throw bad(err.message); } };

  const loadRecord = async req => {
    const id = Number(req.params.id);
    const r = Number.isInteger(id) ? await store.getRecord(id) : null;
    if (!r) throw new HttpError(404, 'No such record');
    return r;
  };
  // The version check the store repeats atomically; doing it here first is what
  // lets the 409 carry the current record for the editor to show.
  const atVersion = (r, body) => {
    const v = validVersion((body || {}).version);
    if (v !== r.version) throw new HttpError(409, `This record changed while you were editing it (now version ${r.version}, last edited by ${r.updated_by || 'someone'})`, { current: recordView(r, now()) });
    return v;
  };
  // The record's own fields, carried into a write that changes only some of them.
  const keep = r => ({ ...Object.fromEntries(MUTABLE.map(f => [f, r[f]])), ...derived(r.kind, r.key, r.data) });
  const log = (what, r, c) => console.log(`[gk] ${what} ${r.jurisdiction}/${r.kind}/${r.key} #${r.id} by ${c.actor}`);

  // ── Reads ──

  app.get('/api/grant-knowledge/overview', team, guard(async (req, res) => {
    const records = await store.listRecords();
    const federal = federalBaseline(records, now());
    res.json({ jurisdictions: JURISDICTION_CODES.map(code => overviewRow(assemble(code, records, { now: now(), federal }))) });
  }));

  app.get('/api/grant-knowledge/jurisdictions/:code', team, guard(async (req, res) => {
    const code = validJurisdiction(req.params.code);
    const includeArchived = req.query.include_archived === '1';
    const records = await store.listRecords();
    const doc = assemble(code, records, { now: now(), federal: federalBaseline(records, now()) });
    if (includeArchived) doc.archived = (await store.listRecords({ jurisdiction: code, includeArchived: true })).filter(r => r.archived_at).map(r => recordView(r, now()));
    res.json(doc);
  }));

  app.get('/api/grant-knowledge/jurisdictions/:code/requirements', team, guard(async (req, res) => {
    const code = validJurisdiction(req.params.code);
    const records = await store.listRecords();
    const doc = assemble(code, records, { now: now(), federal: federalBaseline(records, now()) });
    const want = String(req.query.program || '');
    const programs = doc.programs.filter(p => !want || p.key.toLowerCase() === want.toLowerCase());
    if (want && !programs.length) throw new HttpError(404, `${code} has no program "${want}". Programs: ${doc.programs.map(p => p.key).join(', ') || 'none recorded'}`);
    res.json({ code, name: doc.name, programs: programs.map(p => ({ key: p.key, name: p.data.name, type: p.data.type, status: p.data.status || 'active', submission: p.data.submission || null, ...checklist(p) })) });
  }));

  app.get('/api/grant-knowledge/jurisdictions/:code/revisions', team, guard(async (req, res) => {
    const code = validJurisdiction(req.params.code);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await store.listRevisions({ jurisdiction: code, limit, before: parseInt(req.query.before, 10) || undefined });
    res.json({ revisions: rows.map(revisionView) });
  }));

  app.get('/api/grant-knowledge/revisions', team, guard(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    res.json({ revisions: (await store.listRevisions({ limit, before: parseInt(req.query.before, 10) || undefined })).map(revisionView) });
  }));

  app.get('/api/grant-knowledge/records/:id', team, guard(async (req, res) => res.json(recordView(await loadRecord(req), now()))));

  app.get('/api/grant-knowledge/records/:id/revisions', team, guard(async (req, res) => {
    const r = await loadRecord(req);
    res.json({ revisions: (await store.listRevisions({ recordId: r.id, limit: 200 })).map(revisionView) });
  }));

  app.get('/api/grant-knowledge/search', team, guard(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ q, hits: [] });
    const kinds = String(req.query.kinds || '').split(',').map(s => s.trim()).filter(k => KINDS.includes(k));
    const jurisdiction = req.query.state ? validJurisdiction(req.query.state) : undefined;
    // A hit under an archived program is not a hit; ancestry needs the whole set.
    const alive = new Set(activeTree(await store.listRecords()).map(r => r.id));
    const rows = (await store.search(q, { jurisdiction, kinds })).filter(r => alive.has(r.id));
    const needle = q.toLowerCase().split(/\s+/)[0];
    res.json({ q, hits: rows.map(r => {
      const hay = searchTextFor(r.kind, r.key, r.data).replace(/\s+/g, ' ');
      const at = Math.max(hay.indexOf(needle), 0);
      return { jurisdiction: r.jurisdiction, name: JURISDICTIONS[r.jurisdiction], kind: r.kind, record_id: r.id, title: titleFor(r.kind, r.key, r.data), snippet: hay.slice(Math.max(at - 60, 0), at + 140).trim() };
    }) });
  }));

  app.get('/api/grant-knowledge/needs-attention', team, guard(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 45, 1), 365);
    const code = req.query.state ? validJurisdiction(req.query.state) : undefined;
    res.json(attention(await store.listRecords(), { now: now(), days, code }));
  }));

  // ── Writes ──

  app.post('/api/grant-knowledge/records', team, guard(async (req, res) => {
    const b = req.body || {}, c = ctx(req);
    const jurisdiction = validJurisdiction(b.jurisdiction);
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);

    let parent = null;
    if (b.parent_id !== undefined && b.parent_id !== null) {
      parent = await store.getRecord(Number(b.parent_id));
      if (!parent || parent.jurisdiction !== jurisdiction) throw bad(`parent_id ${b.parent_id} is not a record in ${jurisdiction}`);
      if (parent.archived_at) throw bad('The parent record is archived; restore it first');
    }
    if (!PARENT_KINDS[kind].includes(parent ? parent.kind : null)) {
      const allowed = PARENT_KINDS[kind].map(k => k || 'none').join(' or ');
      throw bad(`A ${kind} hangs under: ${allowed}. Got: ${parent ? parent.kind : 'none'}`);
    }

    const data = parse(kind, mergeData({}, b.data || {}));
    const source_url = validSourceUrl(b.source_url);
    requireProvenance(c.actor_kind, source_url, b.reason);

    let key = b.key !== undefined && b.key !== null ? String(b.key).trim() : '';
    if (kind === 'jurisdiction') key = jurisdiction;
    else if (!key) {
      if (kind === 'program') throw bad('A program needs a key, its short id, e.g. NSGP-S or SCAHC');
      key = kind === 'cycle' ? String(data.fiscal_year) : slugKey(titleFor(kind, '', data));
      // Contacts, notes and sources are told apart by a number when two share a title.
      if (['contact', 'note', 'source'].includes(kind)) {
        for (let n = 2, stem = key; await store.findNatural(jurisdiction, kind, parent?.id, key); n++) key = `${stem}-${n}`.slice(0, 80);
      }
    }
    if (!KEY_RE.test(key)) throw bad('key must be 1-80 letters, digits, dot, dash or underscore');
    const existing = await store.findNatural(jurisdiction, kind, parent?.id, key);
    if (existing) {
      throw new HttpError(409, existing.archived_at ? `${kind} "${key}" exists but is archived; restore it instead` : `${kind} "${key}" already exists here; update it instead`, { existing: recordView(existing, now()) });
    }

    const verify = b.verify === true && c.actor_kind !== 'mcp';
    const row = await store.createRecord({
      jurisdiction, kind, parent_id: parent?.id || null, key, data, ...derived(kind, key, data),
      sort_order: Number.isInteger(b.sort_order) ? b.sort_order : 0,
      status: verify ? 'verified' : 'unverified', unverified_fields: [],
      verified_at: verify ? now().toISOString() : null, verified_by: verify ? c.actor : '',
      source_url, origin: originFor(c.actor_kind, b.origin),
    }, { ...c, action: 'create', before: null, changed_fields: Object.keys(data), reason: String(b.reason || '').slice(0, 1000) });
    log('create', row, c);
    res.status(201).json(recordView(row, now()));
  }));

  app.patch('/api/grant-knowledge/records/:id', team, guard(async (req, res) => {
    const b = req.body || {}, c = ctx(req);
    const r = await loadRecord(req);
    const version = atVersion(r, b);
    if (r.archived_at) throw new HttpError(409, 'This record is archived; restore it before editing');

    const data = parse(r.kind, mergeData(r.data, b.data));
    const changedData = [...new Set([...Object.keys(r.data), ...Object.keys(data)])].filter(k => !sameJson(r.data[k], data[k]));
    const next = keep(r);
    const changed = [...changedData];
    if (b.key !== undefined && r.kind !== 'jurisdiction' && String(b.key).trim() !== r.key) {
      const key = String(b.key).trim();
      if (!KEY_RE.test(key)) throw bad('key must be 1-80 letters, digits, dot, dash or underscore');
      if (await store.findNatural(r.jurisdiction, r.kind, r.parent_id, key)) throw new HttpError(409, `${r.kind} "${key}" already exists here`);
      next.key = key; changed.push('@key');
    }
    if (b.source_url !== undefined && validSourceUrl(b.source_url) !== (r.source_url || '')) { next.source_url = validSourceUrl(b.source_url); changed.push('@source_url'); }
    if (Number.isInteger(b.sort_order) && b.sort_order !== r.sort_order) { next.sort_order = b.sort_order; changed.push('@sort_order'); }

    const verify = b.verify === true && c.actor_kind !== 'mcp';
    if (!changed.length && !verify) return res.json(recordView(r, now()));
    if (changedData.length) requireProvenance(c.actor_kind, next.source_url, b.reason);

    next.data = data;
    Object.assign(next, derived(r.kind, next.key, data));
    if (verify) {
      Object.assign(next, { status: 'verified', verified_at: now().toISOString(), verified_by: c.actor, unverified_fields: [] });
      changed.push('@status');
    } else if (r.status === 'verified') {
      // The rest of the record keeps its verification; only what moved is in doubt.
      next.unverified_fields = [...new Set([...(r.unverified_fields || []), ...changedData])].filter(k => k in data);
    }
    const row = await store.updateRecord(r.id, version, next, { ...c, action: verify && !changedData.length ? 'verify' : 'update', before: snapshot(r), changed_fields: changed, reason: String(b.reason || '').slice(0, 1000) });
    log('update', row, c);
    res.json(recordView(row, now()));
  }));

  // The four one-field moves. Each is a version-checked update like any other, so
  // each leaves a revision and each can be reverted.
  const MOVES = {
    verify: (r, c) => ({ status: 'verified', verified_at: now().toISOString(), verified_by: c.actor, unverified_fields: [] }),
    unverify: () => ({ status: 'unverified', verified_at: null, verified_by: '', unverified_fields: [] }),
    archive: (r, c) => ({ archived_at: now().toISOString(), archived_by: c.actor }),
    restore: () => ({ archived_at: null, archived_by: '' }),
  };
  async function move(action, r, version, c, reason) {
    if (action === 'archive' && r.archived_at) throw new HttpError(409, 'Already archived');
    if (action === 'restore' && !r.archived_at) throw new HttpError(409, 'This record is not archived');
    if (action === 'verify' && r.archived_at) throw new HttpError(409, 'This record is archived; restore it first');
    const row = await store.updateRecord(r.id, version, { ...keep(r), ...MOVES[action](r, c) },
      { ...c, action, before: snapshot(r), changed_fields: [action === 'archive' || action === 'restore' ? '@archived' : '@status'], reason: String(reason || '').slice(0, 1000) });
    log(action, row, c);
    return row;
  }
  for (const action of Object.keys(MOVES)) {
    app.post(`/api/grant-knowledge/records/:id/${action}`, team, guard(async (req, res) => {
      const r = await loadRecord(req);
      const row = await move(action, r, atVersion(r, req.body), ctx(req), (req.body || {}).reason);
      res.json(recordView(row, now()));
    }));
  }

  app.post('/api/grant-knowledge/jurisdictions/:code/verify-bulk', team, guard(async (req, res) => {
    const code = validJurisdiction(req.params.code), c = ctx(req);
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.slice(0, 500) : null;
    if (!ids?.length) throw bad('ids must be a list of { id, version }');
    const results = [];
    for (const item of ids) {
      try {
        const r = await store.getRecord(Number(item.id));
        if (!r || r.jurisdiction !== code) throw new HttpError(404, 'No such record here');
        results.push({ id: r.id, ok: true, record: recordView(await move('verify', r, atVersion(r, item), c, req.body.reason), now()) });
      } catch (err) { results.push({ id: item.id, ok: false, error: err.message }); }
    }
    res.json({ verified: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
  }));

  // Revert puts a record back to how it was before one revision. It is itself a
  // new revision, so a revert can be reverted and the history never loses a step.
  app.post('/api/grant-knowledge/revisions/:id/revert', team, guard(async (req, res) => {
    const c = ctx(req);
    const rev = await store.getRevision(Number(req.params.id));
    if (!rev) throw new HttpError(404, 'No such revision');
    const r = await store.getRecord(rev.record_id);
    const version = atVersion(r, req.body);
    const reason = String((req.body || {}).reason || '').slice(0, 1000) || `Reverted revision ${rev.id} (${rev.action} by ${rev.actor})`;

    let fields;
    if (!rev.before) {
      // The revision created the record: undoing that is taking it out of view.
      if (r.archived_at) throw new HttpError(409, 'Already archived');
      fields = { ...keep(r), archived_at: now().toISOString(), archived_by: c.actor };
    } else {
      const b = rev.before;
      if (b.key !== r.key && await store.findNatural(r.jurisdiction, r.kind, r.parent_id, b.key)) throw new HttpError(409, `Cannot revert: another ${r.kind} now uses the key "${b.key}"`);
      const data = parse(r.kind, b.data);
      fields = {
        ...keep(r), key: b.key, data, ...derived(r.kind, b.key, data), sort_order: b.sort_order || 0,
        status: b.status, unverified_fields: b.unverified_fields || [], verified_at: b.verified_at, verified_by: b.verified_by || '',
        source_url: b.source_url || '', archived_at: b.archived_at, archived_by: b.archived_by || '',
      };
    }
    const changed = MUTABLE.filter(f => !['search_text', 'sort_date'].includes(f) && !sameJson(f === 'verified_at' || f === 'archived_at' ? iso(r[f]) : r[f], fields[f])).map(f => (f === 'data' ? 'data' : `@${f}`));
    const row = await store.updateRecord(r.id, version, fields, { ...c, action: 'revert', before: snapshot(r), changed_fields: changed, reason, reverted_revision_id: rev.id });
    log(`revert r${rev.id}`, row, c);
    res.json(recordView(row, now()));
  }));
}
