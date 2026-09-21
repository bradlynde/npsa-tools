/*
 * NSGP deadlines, served from the grant knowledge base.
 *
 * The toolbox's deadline table (nsgp_deadlines, see nsgp-deadlines.js) was the
 * first place the team kept dates by hand. The knowledge base now holds every row
 * it had (the import read the live table) plus what it never could: more than one
 * stage per cycle, a time of day, a time zone, and whether a person has verified
 * the date. So the readers of that table read the knowledge base instead, through
 * this adapter, which hands back rows in the table's own shape — the briefing, the
 * toolbox panel and the MCP tool keep working unchanged — with the new facts added
 * alongside rather than in place of anything.
 *
 * The old table stays, untouched, as the fallback: if the knowledge base cannot be
 * read, or holds no deadlines at all, the rows come from it as before and say so
 * (`source: 'legacy-table'`), so a bad deploy degrades to yesterday's answer rather
 * than to no answer.
 *
 * One thing is deliberately stricter than the table was. A row reads "confirmed"
 * only when the source stated the date plainly AND a person has verified the
 * record with the date as it now stands. A date Claude found, or one somebody has
 * edited since it was verified, is still worth showing, but as "recorded, confirm
 * before relying on it" — presenting that kind as confirmed is the failure the
 * table was built to end.
 */

import { recordView, zonedInstant, legacyReference } from './grant-knowledge.js';
import { listDeadlines, deadlinesForState } from './nsgp-deadlines.js';
import { seedRecords } from './knowledge.js';

const DEFAULT_TZ = 'America/New_York';

/** The legacy `program` column: 'federal' for NSGP itself, the acronym for a state program. */
function legacyProgram(program, deadline) {
  if (deadline.data.deadline_kind === 'noi') return 'federal-noi';
  return program.data.type === 'federal' ? 'federal' : program.key;
}

function legacyKind(program, deadline) {
  const k = deadline.data.deadline_kind;
  if (k === 'fema') return 'fema';
  return program.data.type === 'federal' ? 'sub_applicant' : 'state_program';
}

/**
 * Every live deadline in the knowledge base as a table row. `records` is the raw
 * record list (store.listRecords()); archived records are left out, and so is a
 * deadline whose cycle or program has been archived.
 */
export function deadlineRowsFromKnowledge(records, now = new Date()) {
  const live = records.filter(r => !r.archived_at);
  const byId = new Map(live.map(r => [r.id, r]));
  const tzOf = new Map(live.filter(r => r.kind === 'jurisdiction').map(r => [r.jurisdiction, r.data.default_tz]));
  const rows = [];

  for (const d of live.filter(r => r.kind === 'deadline')) {
    const cycle = byId.get(d.parent_id);
    const program = cycle && byId.get(cycle.parent_id);
    if (!cycle || !program) continue;
    const v = recordView(d, now);
    const trusted = v.effective_status === 'verified' && !v.unverified_fields.includes('due_date') && !v.unverified_fields.includes('due_time');
    const tz = d.data.tz || tzOf.get(d.jurisdiction) || DEFAULT_TZ;
    rows.push({
      id: d.id,
      state: d.jurisdiction,
      program: legacyProgram(program, d),
      cycle_year: cycle.data.fiscal_year,
      deadline: d.data.due_date,
      kind: legacyKind(program, d),
      note: d.data.note || '',
      source: d.source_url || '',
      confidence: d.data.confidence === 'confirmed' && trusted ? 'confirmed' : 'illustrative',
      layer: 'knowledge-base',
      updated_at: d.updated_at,
      // What the table could not say.
      record_id: d.id,
      program_key: program.key,
      program_name: program.data.name,
      stage_label: d.data.label,
      stage_order: d.data.stage_order ?? 1,
      due_time: d.data.due_time || null,
      tz,
      instant: zonedInstant(d.data.due_date, d.data.due_time, tz).toISOString(),
      deadline_kind: d.data.deadline_kind || null,
      status: v.effective_status,
    });
  }

  // A state can run NSGP-S and NSGP-UA with the same SAA deadline recorded under
  // each. The table had one "federal" row for that, and a rep wants one line.
  // Colorado has exactly this with the time recorded on only one of the two, so
  // the time is not part of what makes them the same; the row that has one lends
  // it to the row that is kept.
  const seen = new Map();
  const out = [];
  for (const r of rows.sort((a, b) => (a.program_key === 'NSGP-S' ? -1 : 0) - (b.program_key === 'NSGP-S' ? -1 : 0))) {
    const k = `${r.state}|${r.program}|${r.cycle_year}|${r.deadline}|${r.stage_label}`;
    const first = seen.get(k);
    if (first) {
      if (!first.program_keys.includes(r.program_key)) first.program_keys.push(r.program_key);
      if (!first.due_time && r.due_time) Object.assign(first, { due_time: r.due_time, tz: r.tz, instant: r.instant });
      if (r.confidence === 'illustrative') first.confidence = 'illustrative';
      continue;
    }
    r.program_keys = [r.program_key];
    seen.set(k, r);
    out.push(r);
  }
  // The table's own order: state, program, newest cycle first; stages in order within a cycle.
  return out.sort((a, b) => a.state.localeCompare(b.state) || a.program.localeCompare(b.program)
    || b.cycle_year - a.cycle_year || a.stage_order - b.stage_order || a.deadline.localeCompare(b.deadline));
}

/**
 * Where the deadline readers get their rows. `store` is the knowledge store;
 * `pool` is only for the fallback to the old table.
 */
export function createDeadlineSource({ store, pool, now = () => new Date(), log = console } = {}) {
  async function fromKnowledge() {
    if (!store) return null;
    try {
      const records = await store.listRecords();
      const rows = deadlineRowsFromKnowledge(records, now());
      return rows.length ? { rows, records } : null;
    } catch (err) {
      log.error(`[deadlines] knowledge base unreadable, using the old table: ${err.message}`);
      return null;
    }
  }
  return {
    /** Every row, plus the state reference, in the shape GET /api/precall/deadlines has always had. */
    async list() {
      const kb = await fromKnowledge();
      if (kb) return { deadlines: kb.rows, reference: legacyReference(kb.records, now()), source: 'knowledge-base' };
      if (!pool) throw Object.assign(new Error('Storage not configured'), { status: 503 });
      return { deadlines: await listDeadlines(pool), reference: legacyReference(seedRecords(), now()), source: 'legacy-table' };
    },
    /** One state's rows plus the federal (US) ones, newest cycle first. */
    async forState(state) {
      const st = String(state || '').trim().toUpperCase();
      if (!st) return [];
      const kb = await fromKnowledge();
      if (kb) return kb.rows.filter(r => r.state === st || r.state === 'US').sort((a, b) => b.cycle_year - a.cycle_year || a.stage_order - b.stage_order);
      return pool ? deadlinesForState(pool, st) : [];
    },
  };
}
