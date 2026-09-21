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
// Attachments hang off the same records (gk_files): a NOFO, an SAA's own
// checklist, a screenshot of a portal step. See the Attachments section below for
// why they travel on a ticket rather than through the Vercel passthrough.
//
//   ensureGrantKnowledgeSchema(pool)                         // at boot
//   registerGrantKnowledge(app, { store, internalKey })      // before the /api 404

import crypto from 'crypto';
import { teamGate } from './intake.js';
import { driveConfigured, uploadToDrive } from './drive.js';
import {
  UPLOAD_MAX_BYTES, PDF, PNG, JPEG, DOCX, XLSX, TYPE_NAME, sniffType, safeFilename,
  contentDisposition, rawUploadBody, uploadBodyError, readMultipart, corsForOrigins, baseUrl, ticketSigner,
} from './uploads.js';
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
  // A state's own requirement with the same key as a baseline one is that line as
  // this state runs it (Texas's "ij" carries Texas's note about the fillable form),
  // so it stands in for the baseline line rather than appearing beside it.
  const federalKeys = new Set(federal.map(r => r.key));
  for (const p of programs) {
    if (code !== 'US' && p.data.type === 'federal') p.requirements = p.requirements.map(r => (federalKeys.has(r.key) ? { ...r, baseline: 'federal' } : r));
  }
  for (const p of programs) {
    const inherited = [];
    const from = p.data.inherits_from && programs.find(x => x.key === p.data.inherits_from && x.id !== p.id);
    if (from) inherited.push(...from.requirements.map(r => ({ ...r, inherited_from: from.key })));
    if (code !== 'US' && p.data.type === 'federal') inherited.push(...federal.map(r => ({ ...r, baseline: 'federal' })));
    const taken = new Set(p.requirements.map(r => r.key));
    p.inherited_requirements = inherited.filter(r => { if (taken.has(r.key)) return false; taken.add(r.key); return true; });
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

// ── The same document as prose ────────────────────────────────────────────────
//
// What a grant writer (or Claude, drafting for one) reads top to bottom: the brief
// that replaces the Drive folder's states/XX.md. Unverified facts say so inline.

const money = n => (typeof n === 'number' ? `$${n.toLocaleString('en-US')}` : '');
const flag = v => (v.effective_status === 'verified' && !v.unverified_fields.length ? '' : v.effective_status === 'stale' ? ' _(stale: verify)_' : ' _(unverified)_');
const when = d => `${d.data.due_date}${d.data.due_time ? ` ${d.data.due_time}` : ''}${d.data.tz ? ` ${d.data.tz.split('/').pop().replace(/_/g, ' ')} time` : ''}`;

export function renderMarkdown(doc) {
  const out = [];
  const j = doc.jurisdiction?.data || {};
  out.push(`# ${doc.name} (${doc.code})`, '');
  // Some SAA names already end in their own acronym ("... Homeland Security (KOHS)"),
  // which read as "(KOHS) (KOHS)" when the short name went on the end regardless.
  if (j.saa) {
    const short = j.saa_short && !new RegExp(`\\b${String(j.saa_short).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(j.saa) ? ` (${j.saa_short})` : '';
    out.push(`**SAA:** ${j.saa}${short}${doc.jurisdiction ? flag(doc.jurisdiction) : ''}`);
  }
  if (j.urban_areas?.length) out.push(`**Urban areas:** ${j.urban_areas.join('; ')}`);
  if (j.partner) out.push(`**Partner:** ${j.partner}`);
  if (j.cycle_status) out.push(`**Cycle status:** ${j.cycle_status}`);
  out.push(`**Where it stands:** ${doc.cycle_state}${doc.next_deadline ? `; next deadline ${doc.next_deadline.label}, ${doc.next_deadline.due_date} (${doc.next_deadline.days_away} days)` : ''}`);
  out.push(`**Freshness:** ${doc.freshness.verified} verified, ${doc.freshness.unverified} unverified, ${doc.freshness.stale} stale; ${doc.open_questions} open question(s)`, '');
  if (j.summary_md) out.push(j.summary_md, '');

  const stoppers = [...doc.notes, ...doc.programs.flatMap(p => p.notes)].filter(n => n.data.severity === 'auto_disqualifier');
  if (stoppers.length) { out.push('## Read first: these end an application', ''); for (const n of stoppers) out.push(`- **${n.data.title}**${flag(n)}${n.data.body_md ? `: ${n.data.body_md}` : ''}`); out.push(''); }

  for (const p of doc.programs) {
    const d = p.data;
    out.push(`## ${p.key}: ${d.name}${d.status && d.status !== 'active' ? ` [${d.status.toUpperCase()}]` : ''}${flag(p)}`, '');
    const facts = [
      ['Type', d.type], ['Administered by', d.administered_by], ['Cap per location', money(d.cap_per_location)], ['Cap per applicant', money(d.cap_per_applicant)],
      ['Locations', d.locations_max], ['M&A', d.ma_pct === undefined ? '' : `${d.ma_pct}%`], ['Cost match', d.cost_match], ['Period of performance', d.pop_months ? `${d.pop_months} months` : ''],
      ['Stackable with federal', d.stackable === undefined ? '' : String(d.stackable)], ['Cannot be won together with', (d.exclusive_with || []).join(', ')],
      ['Deadline authority', d.deadline_authority], ['Availability', d.availability_note],
    ].filter(([, v]) => v !== undefined && v !== '');
    for (const [k, v] of facts) out.push(`- **${k}:** ${v}${d.field_notes?.[{ 'Cap per location': 'cap_per_location', 'Cap per applicant': 'cap_per_applicant', Locations: 'locations_max', 'M&A': 'ma_pct', 'Period of performance': 'pop_months' }[k]] ? ` (${d.field_notes[{ 'Cap per location': 'cap_per_location', 'Cap per applicant': 'cap_per_applicant', Locations: 'locations_max', 'M&A': 'ma_pct', 'Period of performance': 'pop_months' }[k]]})` : ''}`);
    if (d.submission) out.push(`- **Submission:** ${[d.submission.method, d.submission.target].filter(Boolean).join(' via ')}`, ...(d.submission.package_note ? [`  - ${d.submission.package_note}`] : []));
    if (d.file_naming) out.push(`- **File naming:** ${d.file_naming}`);
    out.push('');
    const list = checklist(p);
    for (const [title, rows] of [['Registration', list.registration], ['Documents', list.documents]]) {
      if (!rows.length) continue;
      out.push(`### ${title}`, '');
      for (const r of rows) out.push(`- ${r.hard_gate ? '**HARD GATE** ' : ''}${r.label} [${r.owner}${r.baseline === 'federal' ? ', federal baseline' : ''}${r.lead_time_days ? `, allow ${r.lead_time_days} days` : ''}${r.format ? `, ${r.format}` : ''}]${r.status === 'verified' ? '' : ' _(unverified)_'}${r.notes ? `: ${r.notes}` : ''}`);
      out.push('');
    }
    if (p.cycles.length) {
      out.push('### Cycles', '');
      for (const c of p.cycles) {
        const bits = [c.data.status, c.data.open_date ? `opened ${c.data.open_date}` : '', c.data.state_allocation ? `state allocation ${money(c.data.state_allocation)}` : '', c.data.total_funding ? `total ${money(c.data.total_funding)}` : ''].filter(Boolean).join(', ');
        out.push(`- **${c.title}**${bits ? ` (${bits})` : ''}${flag(c)}${c.data.notes ? `: ${c.data.notes}` : ''}`);
        for (const dl of c.deadlines) out.push(`  - ${dl.data.label}: ${when(dl)}${dl.data.confidence && dl.data.confidence !== 'confirmed' ? ` [${dl.data.confidence}]` : ''}${flag(dl)}${dl.data.note ? `. ${dl.data.note}` : ''}`);
      }
      out.push('');
    }
    if (d.notes_md) out.push('### Program notes', '', d.notes_md, '');
    if (d.eligible_costs) out.push('### Eligible costs', '', d.eligible_costs, '');
    noteBlock(out, p.notes, '###');
    contactBlock(out, p.contacts, '###');
  }
  contactBlock(out, doc.contacts, '##');
  noteBlock(out, doc.notes, '##');
  if (j.post_award_note) out.push('## Post-award', '', j.post_award_note, '');
  const files = (doc.files || []).filter(f => !f.archived_at);
  if (files.length) {
    out.push('## Files', '');
    // The link is to the Drive copy, which keeps working; the toolbox's own
    // download links are minted per read and are gone within ten minutes.
    for (const f of files) out.push(`- ${f.label || f.filename}${f.label ? ` (${f.filename})` : ''} — ${f.type_name}, ${Math.max(1, Math.round(f.size_bytes / 1024))} KB${f.drive_url ? `, ${f.drive_url}` : ''}`);
    out.push('');
  }
  const sources = [...doc.sources, ...doc.programs.flatMap(p => p.sources)];
  if (sources.length) { out.push('## Sources', ''); for (const s of sources) out.push(`- ${s.data.url}${s.data.covers ? ` (${s.data.covers})` : ''}`); out.push(''); }
  return out.join('\n');
}

const NOTE_ORDER = ['gotcha', 'eligibility', 'prohibited_cost', 'scoring', 'process', 'history', 'post_award', 'watch_item', 'open_question'];
const NOTE_HEADING = { gotcha: 'Gotchas', eligibility: 'Eligibility', prohibited_cost: 'Prohibited costs', scoring: 'Scoring', process: 'Process', history: 'History', post_award: 'Post-award', watch_item: 'Watch items', open_question: 'Open questions' };
function noteBlock(out, notes, h) {
  for (const cat of NOTE_ORDER) {
    const mine = notes.filter(n => n.data.category === cat && !(cat === 'open_question' && n.data.resolved));
    if (!mine.length) continue;
    out.push(`${h} ${NOTE_HEADING[cat]}`, '');
    for (const n of mine) out.push(`- **${n.data.title}**${n.data.client_slug ? ` (from ${n.data.client_slug})` : ''}${flag(n)}${n.data.body_md ? `: ${n.data.body_md.replace(/\n+/g, ' ')}` : ''}`);
    out.push('');
  }
}
function contactBlock(out, contacts, h) {
  if (!contacts.length) return;
  out.push(`${h} Contacts`, '');
  for (const c of contacts) out.push(`- ${[c.data.name, c.data.role, c.data.org].filter(Boolean).join(', ')}${c.data.area ? ` (${c.data.area})` : ''}: ${[c.data.email, c.data.phone].filter(Boolean).join(' / ')}${flag(c)}${c.data.warning ? ` WARNING: ${c.data.warning}` : ''}`);
  out.push('');
}

/** The shape nsgp_state_reference has always returned, read from the knowledge base. */
export function legacyReference(records, now = new Date()) {
  const live = activeTree(records);
  const states = {};
  for (const j of live.filter(r => r.kind === 'jurisdiction' && r.jurisdiction !== 'US')) {
    const programs = live.filter(r => r.kind === 'program' && r.jurisdiction === j.jurisdiction && r.data.type === 'state').sort(bySort);
    states[j.jurisdiction] = {
      saa: j.data.saa || '', saaShort: j.data.saa_short || '', lastVerified: j.verified_at ? iso(j.verified_at).slice(0, 10) : '',
      programs: programs.map(p => ({
        acronym: p.key, name: p.data.name, perSite: p.data.cap_per_location ?? null, perApplicant: p.data.cap_per_applicant ?? null,
        stackable: p.data.stackable ?? 'verify', note: p.data.notes_md || p.data.submission?.package_note || '',
        ...(p.data.exclusive_with?.length ? { exclusiveWith: [p.key, ...p.data.exclusive_with] } : {}),
        ...(p.data.status === 'dormant' ? { dormant: true } : {}), ...(p.data.status === 'unconfirmed' ? { unconfirmed: true } : {}),
        ...(p.data.administered_by ? { administeredBy: p.data.administered_by } : {}), ...(p.data.availability_note ? { availabilityNote: p.data.availability_note } : {}),
      })),
    };
  }
  return { source: 'knowledge-base', checkedOn: now.toISOString().slice(0, 10), notCovered: JURISDICTION_CODES.filter(c => c !== 'US' && !states[c]), states };
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

    CREATE TABLE IF NOT EXISTS gk_files (
      id            SERIAL PRIMARY KEY,
      jurisdiction  TEXT NOT NULL,
      record_id     INT REFERENCES gk_records(id),
      label         TEXT NOT NULL DEFAULT '',
      filename      TEXT NOT NULL,
      mime          TEXT NOT NULL,
      size_bytes    INT  NOT NULL,
      sha256        TEXT NOT NULL DEFAULT '',
      content       BYTEA,
      drive_file_id TEXT NOT NULL DEFAULT '',
      drive_url     TEXT NOT NULL DEFAULT '',
      source_url    TEXT NOT NULL DEFAULT '',
      uploaded_by   TEXT NOT NULL DEFAULT '',
      uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
      archived_at   TIMESTAMPTZ,
      archived_by   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS gk_files_jurisdiction ON gk_files (jurisdiction) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS gk_files_record ON gk_files (record_id) WHERE archived_at IS NULL;
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

const FILE_COLS = `id, jurisdiction, record_id, label, filename, mime, size_bytes, sha256,
  drive_file_id, drive_url, source_url, uploaded_by, uploaded_at, archived_at, archived_by`;

/** What the team keeps next to the facts, and how long a link to one lasts. */
const FILE_TYPES = [PDF, PNG, JPEG, DOCX, XLSX];
const INLINE_TYPES = new Set([PDF, PNG, JPEG]);
const UPLOAD_TICKET_MS = 15 * 60 * 1000;
const DOWNLOAD_TICKET_MS = 10 * 60 * 1000;
// Where the tab is served from. Set GK_APP_ORIGINS when that changes; a preview
// deployment on its own hostname needs adding, or its uploads get no CORS answer.
const DEFAULT_APP_ORIGINS = ['https://npsa-tools.vercel.app', 'http://localhost:3100', 'http://localhost:3110'];

function fileView(f, downloadUrl = null) {
  return {
    id: f.id, jurisdiction: f.jurisdiction, record_id: f.record_id ?? null, label: f.label || '',
    filename: f.filename, mime: f.mime, type_name: TYPE_NAME[f.mime] || f.mime, size_bytes: f.size_bytes,
    drive_url: f.drive_url || '', source_url: f.source_url || '',
    uploaded_by: f.uploaded_by || '', uploaded_at: iso(f.uploaded_at),
    archived_at: iso(f.archived_at), archived_by: f.archived_by || '',
    download_url: downloadUrl,
  };
}

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

    // Attachments. The bytes stay out of every listing: a state with ten NOFOs in
    // it would otherwise put 60 MB through the page that only wanted their names.
    addFile: f => one(
      `INSERT INTO gk_files (jurisdiction, record_id, label, filename, mime, size_bytes, sha256, content, source_url, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${FILE_COLS}`,
      [f.jurisdiction, f.record_id || null, f.label || '', f.filename, f.mime, f.size_bytes, f.sha256 || '', f.content, f.source_url || '', f.uploaded_by || '']),
    async setFileDrive(id, { drive_file_id, drive_url }) {
      await pool.query('UPDATE gk_files SET drive_file_id=$2, drive_url=$3 WHERE id=$1', [id, drive_file_id, drive_url]);
    },
    async listFiles({ jurisdiction, recordId, includeArchived = false } = {}) {
      const { rows } = await pool.query(
        `SELECT ${FILE_COLS} FROM gk_files
          WHERE ($1::text IS NULL OR jurisdiction = $1) AND ($2::int IS NULL OR record_id = $2) AND ($3 OR archived_at IS NULL)
          ORDER BY uploaded_at DESC, id DESC`, [jurisdiction || null, recordId || null, includeArchived]);
      return rows;
    },
    getFile: id => one(`SELECT ${FILE_COLS} FROM gk_files WHERE id = $1`, [id]),
    getFileContent: id => one('SELECT id, filename, mime, content, archived_at FROM gk_files WHERE id = $1', [id]),
    findFileHash: (jurisdiction, sha256) => one(
      `SELECT ${FILE_COLS} FROM gk_files WHERE jurisdiction = $1 AND sha256 = $2 AND archived_at IS NULL LIMIT 1`, [jurisdiction, sha256]),
    setFileArchived: (id, at, by) => one(
      `UPDATE gk_files SET archived_at = $2, archived_by = $3 WHERE id = $1 RETURNING ${FILE_COLS}`, [id, at, by]),
  };
}

export function createMemoryKnowledgeStore({ now = () => new Date() } = {}) {
  const records = [], revisions = [], files = [];
  let nextId = 1, nextRevision = 1, nextFile = 1;
  const copy = v => JSON.parse(JSON.stringify(v));
  // The Postgres store leaves the bytes out of every listing; the twin has to as
  // well, or a test would pass here on a shape the real store never returns.
  const withoutContent = ({ content, ...rest }) => ({ ...rest });
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

    async addFile(f) {
      const row = {
        id: nextFile++, jurisdiction: f.jurisdiction, record_id: f.record_id || null, label: f.label || '', filename: f.filename,
        mime: f.mime, size_bytes: f.size_bytes, sha256: f.sha256 || '', content: f.content, drive_file_id: '', drive_url: '',
        source_url: f.source_url || '', uploaded_by: f.uploaded_by || '', uploaded_at: now().toISOString(), archived_at: null, archived_by: '',
      };
      files.push(row);
      return withoutContent(row);
    },
    async setFileDrive(id, { drive_file_id, drive_url }) {
      const row = files.find(x => x.id === id);
      if (row) Object.assign(row, { drive_file_id, drive_url });
    },
    async listFiles({ jurisdiction, recordId, includeArchived = false } = {}) {
      return files.filter(f => (!jurisdiction || f.jurisdiction === jurisdiction) && (!recordId || f.record_id === recordId) && (includeArchived || !f.archived_at))
        .sort((a, b) => b.id - a.id).map(withoutContent);
    },
    async getFile(id) { const f = files.find(x => x.id === id); return f ? withoutContent(f) : null; },
    async getFileContent(id) {
      const f = files.find(x => x.id === id);
      return f ? { id: f.id, filename: f.filename, mime: f.mime, content: f.content, archived_at: f.archived_at } : null;
    },
    async findFileHash(jurisdiction, sha256) {
      const f = files.find(x => x.jurisdiction === jurisdiction && x.sha256 === sha256 && !x.archived_at);
      return f ? withoutContent(f) : null;
    },
    async setFileArchived(id, at, by) {
      const f = files.find(x => x.id === id);
      if (!f) return null;
      Object.assign(f, { archived_at: at, archived_by: by });
      return withoutContent(f);
    },
  };
}

// ── Writes: how a request becomes the next version of a record ────────────────

// Postgres hands JSONB back with its keys in its own order, so equality has to be
// blind to key order or every stored record looks changed.
const canonical = v => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v ?? null);
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function validJurisdiction(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!JURISDICTIONS[c]) throw bad('jurisdiction must be a USPS state code, DC, PR, GU, VI, AS, MP, or US');
  return c;
}

const splitOrigins = v => String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

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

export function registerGrantKnowledge(app, {
  store, internalKey, now = () => new Date(),
  drive, driveFolderId = process.env.GK_DRIVE_FOLDER_ID || '',
  appOrigins = splitOrigins(process.env.GK_APP_ORIGINS), uploadBase = process.env.GK_UPLOAD_BASE || '',
} = {}) {
  const team = teamGate({ internalKey });
  if (drive === undefined) drive = driveConfigured() ? { upload: uploadToDrive } : null;
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

  // Attachments: the ticket signer and the two links it makes. The routes are at
  // the foot of this function; these live here because the state page hands back
  // its files along with its facts.
  const tickets = ticketSigner(internalKey);
  const fileBase = req => String(uploadBase || baseUrl(req)).replace(/\/+$/, '');
  const downloadLink = (req, f) =>
    `${fileBase(req)}/api/grant-knowledge/files/${f.id}/content?t=${encodeURIComponent(tickets.sign({ p: 'down', f: f.id }, DOWNLOAD_TICKET_MS, now().getTime()))}`;
  const seeFile = (req, f) => fileView(f, f.archived_at ? null : downloadLink(req, f));

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
    doc.files = (await store.listFiles({ jurisdiction: code, includeArchived })).map(f => seeFile(req, f));
    if (req.query.format === 'markdown') return res.type('text/markdown').send(renderMarkdown(doc));
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

  // The legacy state reference, for nsgp_state_reference and the consumers that
  // still expect its shape. Empty until the import has run; callers fall back.
  app.get('/api/grant-knowledge/reference', team, guard(async (req, res) => res.json(legacyReference(await store.listRecords(), now()))));

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

  // ── Import and export ──
  //
  // A bundle is a flat list of records, parents before children, each with an
  // import_key and its parent's. Loading one twice is safe: a record the import made
  // and nobody has touched since is brought up to the bundle; a record a person or
  // Claude has edited is left alone and listed, the same promise the deadline table
  // made with layer = 'manual'. Neither route is on the toolbox proxy's allowlist.

  app.post('/api/grant-knowledge/import', team, guard(async (req, res) => {
    const c = { actor: `import:${ctx(req).actor}`, actor_kind: 'import' };
    const list = (req.body || {}).records;
    const dryRun = (req.body || {}).dry_run === true;
    if (!Array.isArray(list) || !list.length) throw bad('records must be a non-empty list');
    const out = { dry_run: dryRun, created: 0, updated: 0, unchanged: 0, skipped: [], errors: [] };
    const idOf = new Map(); // import_key → record id, for parents created in this same call

    for (const item of list.slice(0, 5000)) {
      try {
        const importKey = String(item.import_key || '');
        if (!importKey) throw bad('import_key is required');
        const jurisdiction = validJurisdiction(item.jurisdiction);
        if (!KINDS.includes(item.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
        const data = parse(item.kind, mergeData({}, item.data || {}));
        const key = item.kind === 'jurisdiction' ? jurisdiction : String(item.key || '');
        if (!KEY_RE.test(key)) throw bad('key must be 1-80 letters, digits, dot, dash or underscore');

        let parentId = null;
        if (item.parent) {
          parentId = idOf.get(item.parent) ?? (await store.findImportKey(String(item.parent)))?.id ?? null;
          if (parentId === null && !(dryRun && idOf.has(item.parent))) throw bad(`parent ${item.parent} has not been imported`);
        }
        const verified = item.status === 'verified';
        const fields = {
          key, data, ...derived(item.kind, key, data), sort_order: Number.isInteger(item.sort_order) ? item.sort_order : 0,
          status: verified ? 'verified' : 'unverified', unverified_fields: [],
          verified_at: verified ? (item.verified_at || now().toISOString()) : null, verified_by: verified ? String(item.verified_by || 'import').slice(0, 120) : '',
          source_url: validSourceUrl(item.source_url), archived_at: null, archived_by: '',
        };

        const existing = await store.findImportKey(importKey);
        if (!existing) {
          const clash = parentId !== null || !item.parent ? await store.findNatural(jurisdiction, item.kind, parentId, key) : null;
          if (clash) { idOf.set(importKey, clash.id); out.skipped.push({ import_key: importKey, why: 'a record with this key was already made by hand', record_id: clash.id }); continue; }
          if (dryRun) { idOf.set(importKey, null); out.created++; continue; }
          const row = await store.createRecord({ jurisdiction, kind: item.kind, parent_id: parentId, ...fields, origin: 'import', import_key: importKey },
            { ...c, action: 'import', before: null, changed_fields: Object.keys(data) });
          idOf.set(importKey, row.id); out.created++;
          continue;
        }
        idOf.set(importKey, existing.id);
        const [last] = await store.listRevisions({ recordId: existing.id, limit: 1 });
        if (last && last.action !== 'import') { out.skipped.push({ import_key: importKey, why: `edited since the import (${last.action} by ${last.actor})`, record_id: existing.id }); continue; }
        const same = sameJson(existing.data, data) && existing.key === key && existing.status === fields.status && (existing.source_url || '') === fields.source_url && (existing.sort_order || 0) === fields.sort_order;
        if (same) { out.unchanged++; continue; }
        if (!dryRun) await store.updateRecord(existing.id, existing.version, fields, { ...c, action: 'import', before: snapshot(existing), changed_fields: [...new Set([...Object.keys(existing.data), ...Object.keys(data)])].filter(k => !sameJson(existing.data[k], data[k])) });
        out.updated++;
      } catch (err) { out.errors.push({ import_key: item?.import_key || '(none)', error: err.message }); }
    }
    console.log(`[gk] import by ${c.actor}${dryRun ? ' (dry run)' : ''}: ${out.created} created, ${out.updated} updated, ${out.unchanged} unchanged, ${out.skipped.length} skipped, ${out.errors.length} errors`);
    res.json(out);
  }));

  app.get('/api/grant-knowledge/export', team, guard(async (req, res) => {
    const records = activeTree(await store.listRecords());
    const keyOf = new Map(records.map(r => [r.id, r.import_key || `x:${r.id}`]));
    const depth = r => { let d = 0; for (let cur = r; cur?.parent_id && d < 6; cur = records.find(x => x.id === cur.parent_id)) d++; return d; };
    const sorted = [...records].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || depth(a) - depth(b) || a.id - b.id);
    res.json({ exported_at: now().toISOString(), records: sorted.map(r => ({
      import_key: keyOf.get(r.id), jurisdiction: r.jurisdiction, kind: r.kind, parent: r.parent_id ? keyOf.get(r.parent_id) : null, key: r.key, data: r.data,
      status: r.status, verified_by: r.verified_by || '', verified_at: iso(r.verified_at), source_url: r.source_url || '', sort_order: r.sort_order || 0,
    })) });
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

  // ── Attachments ──
  //
  // A NOFO, an SAA's own checklist, a screenshot of the step in the portal that
  // nobody can ever find: things worth keeping next to the facts they came from.
  // Postgres holds the bytes and Drive gets a copy when a folder is configured.
  //
  // They do not travel through the Vercel passthrough, whose functions stop at
  // 4.5 MB. Instead the browser asks this service, through the keyed proxy, for
  // permission to upload, and gets back a short-lived signed ticket naming the
  // state, the record and the person who asked. It then posts the file here
  // directly, carrying the ticket instead of the team key — so the team key never
  // reaches the browser, and the name in `uploaded_by` is the one the gate
  // resolved when the ticket was minted, not one the browser typed. Downloads run
  // the same way in reverse, so a 20 MB PDF does not have to fit back through a
  // serverless response either.

  const filesCors = corsForOrigins(appOrigins.length ? appOrigins : DEFAULT_APP_ORIGINS,
    { methods: 'POST, OPTIONS', headers: 'Content-Type, X-GK-Ticket' });

  const loadFile = async req => {
    const id = Number(req.params.id);
    const f = Number.isInteger(id) ? await store.getFile(id) : null;
    if (!f) throw new HttpError(404, 'No such file');
    return f;
  };

  app.post('/api/grant-knowledge/files/ticket', team, guard(async (req, res) => {
    const b = req.body || {};
    const code = validJurisdiction(b.jurisdiction);
    let recordId = null;
    if (b.record_id !== undefined && b.record_id !== null && b.record_id !== '') {
      const r = await store.getRecord(Number(b.record_id));
      if (!r || r.jurisdiction !== code || r.archived_at) throw bad(`record_id must be a record that is in ${code} and not archived`);
      recordId = r.id;
    }
    const c = ctx(req);
    const at = now().getTime();
    res.json({
      ticket: tickets.sign({ p: 'up', j: code, r: recordId, l: String(b.label || '').trim().slice(0, 120), s: validSourceUrl(b.source_url), a: c.actor }, UPLOAD_TICKET_MS, at),
      upload_url: `${fileBase(req)}/api/grant-knowledge/files/upload`,
      max_bytes: UPLOAD_MAX_BYTES,
      accepts: FILE_TYPES,
      expires_at: new Date(at + UPLOAD_TICKET_MS).toISOString(),
    });
  }));

  app.options('/api/grant-knowledge/files/upload', filesCors);
  app.post('/api/grant-knowledge/files/upload', filesCors, rawUploadBody(), uploadBodyError, guard(async (req, res) => {
    const form = await readMultipart(req);
    if (!form) throw bad('Send the file as multipart form data with a "file" field.');
    const t = tickets.read(req.get('x-gk-ticket') || form.get('ticket'), now().getTime());
    if (!t || t.p !== 'up') throw new HttpError(401, 'That upload window has closed. Start the upload again.');

    const file = form.get('file');
    if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') throw bad('No file was attached.');
    const content = Buffer.from(await file.arrayBuffer());
    if (!content.length) throw bad('The file is empty.');
    if (content.length > UPLOAD_MAX_BYTES) throw new HttpError(413, 'File too large — please keep uploads under 25 MB.');
    const mime = sniffType(content);
    if (!mime || !FILE_TYPES.includes(mime)) throw bad('Unsupported file type — PDF, JPG, PNG, Word or Excel only.');

    // The same file twice is nearly always the same person clicking twice, or two
    // people saving the same NOFO. Hand back the copy that is already there.
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const already = await store.findFileHash(t.j, sha256);
    if (already) return res.json({ ok: true, already: true, file: seeFile(req, already) });

    let row = await store.addFile({
      jurisdiction: t.j, record_id: t.r || null, label: t.l || '', filename: safeFilename(file.name),
      mime, size_bytes: content.length, sha256, content, source_url: t.s || '', uploaded_by: t.a || 'unknown',
    });
    if (drive && driveFolderId) {
      try {
        const d = await drive.upload({ folderId: driveFolderId, filename: `${t.j} ${row.filename}`, mime, content });
        await store.setFileDrive(row.id, { drive_file_id: d.id, drive_url: d.url });
        row = { ...row, drive_file_id: d.id, drive_url: d.url };
      } catch (err) {
        console.warn(`[gk] drive mirror failed for ${t.j}/${row.filename}: ${err.message}`);
      }
    }
    console.log(`[gk] file ${t.j}${t.r ? ` #${t.r}` : ''} ${row.filename} ${content.length}b by ${t.a}${row.drive_url ? ' → drive' : ''}`);
    res.json({ ok: true, file: seeFile(req, row) });
  }));

  app.get('/api/grant-knowledge/files', team, guard(async (req, res) => {
    const rows = await store.listFiles({
      jurisdiction: req.query.jurisdiction ? validJurisdiction(req.query.jurisdiction) : null,
      recordId: req.query.record_id ? Number(req.query.record_id) : null,
      includeArchived: req.query.include_archived === '1',
    });
    res.json({ files: rows.map(f => seeFile(req, f)) });
  }));

  app.get('/api/grant-knowledge/files/:id', team, guard(async (req, res) => res.json(seeFile(req, await loadFile(req)))));

  // No team gate: the ticket in the query string is the authority here, which is
  // what lets a person open the file straight from this service.
  app.get('/api/grant-knowledge/files/:id/content', guard(async (req, res) => {
    const id = Number(req.params.id);
    const t = tickets.read(req.query.t, now().getTime());
    if (!t || t.p !== 'down' || t.f !== id) throw new HttpError(401, 'That download link has expired. Open the file from the page again.');
    const f = await store.getFileContent(id);
    if (!f || !f.content || f.archived_at) throw new HttpError(404, 'No such file');
    res.set('Content-Type', f.mime);
    res.set('Content-Disposition', contentDisposition(f.filename, { inline: INLINE_TYPES.has(f.mime) }));
    res.set('Cache-Control', 'private, no-store');
    // nosniff is what keeps this origin safe, together with the five types the
    // upload accepts on the evidence of their own first bytes: none of them is a
    // document the browser will run, and nosniff stops it deciding otherwise.
    //
    // No `sandbox` CSP, deliberately. It would be the belt and braces, but a
    // fully sandboxed response is an opaque origin and a browser's built-in PDF
    // viewer will not run there, so opening a NOFO becomes a file to save. The
    // thing sandbox would guard against is script in the file reaching this
    // origin, and none of these five types gives it a way to.
    res.set('X-Content-Type-Options', 'nosniff');
    // end(), not send(): send() decides for itself what a body is, and a driver
    // that hands bytea back as anything but a Buffer would have it stringify the
    // file and stamp a charset on a PDF.
    res.end(Buffer.from(f.content));
  }));

  for (const action of ['archive', 'restore']) {
    app.post(`/api/grant-knowledge/files/:id/${action}`, team, guard(async (req, res) => {
      const f = await loadFile(req);
      const archiving = action === 'archive';
      if (Boolean(f.archived_at) === archiving) throw new HttpError(409, `Already ${archiving ? 'archived' : 'in view'}`);
      const c = ctx(req);
      const row = await store.setFileArchived(f.id, archiving ? now().toISOString() : null, archiving ? c.actor : '');
      console.log(`[gk] file ${action} ${row.jurisdiction} ${row.filename} #${row.id} by ${c.actor}`);
      res.json(seeFile(req, row));
    }));
  }
}
