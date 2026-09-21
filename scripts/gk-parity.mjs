/**
 * What the client intake pages show per state, before and after they read the
 * knowledge base: the SAA, registration steps, caps, the state program a "State
 * Program" site draws on, the programs an application can name, and the upload
 * rows for a federal client and for each state program with its own list.
 *
 * Run:  node scripts/gk-parity.mjs                      (the seed bundle)
 *       node scripts/gk-parity.mjs --live > parity.md   (production; NPSA_API_KEY, NPSA_API_BASE optional)
 *       node scripts/gk-parity.mjs --records file.json  (an /export dump or a list of records)
 *       ... --as-verified 1486,1490                     (preview: treat those records as confirmed)
 *
 * "Before" is the intake JSON files; "after" is server/knowledge.js over the
 * records, verified only. Prints one section per state that differs, in markdown.
 * A difference is not a failure: the knowledge base is meant to be more current.
 * Each one should be a change someone is happy to see on a client's page.
 *
 * Two changes that touch every state are named once at the top rather than per
 * state: the SAM.gov line takes the knowledge base's wording, and upload rows come
 * in the knowledge base's order. Lists are compared without either.
 */

import { readFileSync } from 'node:fs';
import { JURISDICTION_CODES } from '../server/grant-knowledge-kinds.js';
import { buildKnowledge, setKnowledgeSnapshot } from '../server/knowledge.js';
import { stateConfig, stateProgram, programsFor, documentsFor, federalSiteCap, referenceContactsFor } from '../server/intake.js';
import { STATE_REFERENCE } from '../server/nsgp-deadlines.js';

const args = process.argv.slice(2);
const flag = f => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1] || true; };

/** Export-shaped rows (import_key + parent) become store-shaped ones (id + parent_id). */
function fromExport(rows) {
  const ids = new Map(rows.map((r, i) => [r.import_key, i + 1]));
  return rows.map((r, i) => ({
    id: i + 1, jurisdiction: r.jurisdiction, kind: r.kind, key: r.key, data: r.data,
    parent_id: r.parent ? ids.get(r.parent) ?? -1 : null, status: r.status || 'unverified',
    unverified_fields: r.unverified_fields || [], sort_order: r.sort_order || 0, verified_at: r.verified_at || null, archived_at: null,
  }));
}

/** Production, one assembled jurisdiction at a time: those views keep unverified_fields, which /export drops. */
async function fromLive() {
  const base = String(process.env.NPSA_API_BASE || 'https://loe-generator-production.up.railway.app').replace(/\/+$/, '');
  const key = process.env.NPSA_API_KEY;
  if (!key) throw new Error('--live needs NPSA_API_KEY');
  const out = [];
  const add = v => out.push({ id: v.id, jurisdiction: v.jurisdiction, kind: v.kind, key: v.key, data: v.data, parent_id: v.parent_id, status: v.status,
    unverified_fields: v.unverified_fields || [], sort_order: v.sort_order || 0, verified_at: v.verified_at, archived_at: null });
  for (const code of JURISDICTION_CODES) {
    const r = await fetch(`${base}/api/grant-knowledge/jurisdictions/${code}`, { headers: { Authorization: `Bearer ${key.replace(/^Bearer\s+/i, '')}` } });
    if (!r.ok) throw new Error(`${code}: HTTP ${r.status}`);
    const doc = await r.json();
    if (doc.jurisdiction) add(doc.jurisdiction);
    for (const p of doc.programs) {
      add(p);
      for (const x of [...p.requirements, ...p.contacts, ...p.notes, ...p.sources]) add(x);
      for (const c of p.cycles) { add(c); for (const d of c.deadlines) add(d); }
    }
    for (const x of [...doc.contacts, ...doc.notes, ...doc.sources]) add(x);
  }
  return out;
}

let records;
if (flag('--live')) records = await fromLive();
else {
  const file = flag('--records') || new URL('../server/grant-knowledge-seed.json', import.meta.url);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.records;
  records = rows[0]?.import_key !== undefined && rows[0]?.id === undefined ? fromExport(rows) : rows;
}

const asVerified = new Set(String(flag('--as-verified') || '').split(',').filter(Boolean).map(Number));
if (asVerified.size) records = records.map(r => (asVerified.has(r.id) ? { ...r, status: 'verified', unverified_fields: [] } : r));

// What a state's client page is fed, for a federal client and for one on each state program.
function view(st) {
  const refPrograms = (STATE_REFERENCE.states[st]?.programs || []).map(p => p.acronym);
  const kbPrograms = programsFor(st).filter(p => p.kind === 'state').map(p => p.code);
  const cfg = stateConfig(st);
  const reg = (cfg.registration || []).map(r => (typeof r === 'string' ? r.replace(/\s*[—-]+\s*hard gate\s*$/i, '') + (/hard gate/i.test(r) ? ' [gate]' : '') : r.label + (r.hard_gate ? ' [gate]' : '')))
    .map(line => (/^SAM\.gov/i.test(line) ? `SAM.gov line${/\[gate\]/.test(line) ? ' [gate]' : ''}` : line));
  const docs = c => documentsFor({ state: st, ...c }).map(d => `${d.key}: ${d.label}${d.hint ? ` (${d.hint})` : ''}`).sort();
  const perProgram = {};
  for (const code of new Set([...refPrograms, ...kbPrograms])) perProgram[code] = docs({ applications: [{ program: code, status: 'active', sites: [1] }] });
  const sp = stateProgram(st);
  return {
    'SAA (page)': cfg.saa,
    'Registration steps': reg,
    'Federal cap line': cfg.perSiteCap,
    'State cap line': cfg.stateCap,
    'Federal cap per site': federalSiteCap(st),
    '"State Program" draws on': sp ? `${sp.acronym}: site ${sp.perSite ?? '—'}, applicant ${sp.perApplicant ?? '—'}` : 'none',
    'Programs an application can name': programsFor(st).map(p => `${p.code} (${p.per_site ?? '—'}/${p.per_applicant ?? '—'})`),
    'Uploads, federal client': docs({}),
    ...Object.fromEntries(Object.entries(perProgram).map(([k, v]) => [`Uploads, ${k} client`, v])),
    'Reference contacts at create': referenceContactsFor(st).map(c => `${c.name} <${c.email}>${c.role ? `, ${c.role}` : ''}`),
  };
}

const states = JURISDICTION_CODES.filter(c => c !== 'US');
setKnowledgeSnapshot(null);
const before = Object.fromEntries(states.map(st => [st, view(st)]));
const kb = buildKnowledge(records);
setKnowledgeSnapshot(kb);
const after = Object.fromEntries(states.map(st => [st, view(st)]));

const show = v => (Array.isArray(v) ? (v.length ? v.map(x => `\n    - ${x}`).join('') : ' (none)') : ` ${v === '' || v == null ? '(blank)' : v}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REFS = 'Reference contacts at create';
// A change that reads the same in many states (a reworded line every state shares) is listed once.
const diffsOf = st => Object.keys({ ...before[st], ...after[st] }).filter(k => k !== REFS && !same(before[st][k], after[st][k]));
const sig = (st, k) => `${k.startsWith('Uploads, ') && k !== 'Uploads, federal client' ? 'Uploads, state program client' : k}\u0000${JSON.stringify(before[st][k])}\u0000${JSON.stringify(after[st][k])}`;
const counts = new Map();
for (const st of states) for (const k of diffsOf(st)) { const s = sig(st, k); counts.set(s, [...(counts.get(s) || []), st]); }
const common = [...counts].filter(([, sts]) => sts.length >= 5);
const commonSet = new Set(common.map(([s]) => s));

const lines = [`# Intake parity: JSON files vs the knowledge base (verified records only)`, '', `${kb.records} verified records, ${Object.keys(kb.states).length} jurisdictions. Only differences are listed.`, '',
  `Everywhere: the SAM.gov step reads "${(kb.states.TX?.registration['NSGP-S'] || []).find(r => /^SAM/.test(r.label))?.label || '?'}", and upload rows follow the knowledge base's order (${documentsFor({ state: 'AK' }).map(d => d.key).join(', ')}). Lists below ignore both.`, ''];
let changed = 0, touched = 0;
if (common.length) {
  lines.push('## The same change in many states', '');
  for (const [s, sts] of common) {
    const [k, b, a] = s.split('\u0000');
    lines.push(`- **${k}** in ${sts.length} states (${sts.join(', ')})`, `  - before:${show(JSON.parse(b))}`, `  - after:${show(JSON.parse(a))}`);
  }
  lines.push('');
}
for (const st of states) {
  const diffs = diffsOf(st).filter(k => !commonSet.has(sig(st, k)));
  const refs = after[st][REFS];
  if (diffsOf(st).length) touched++;
  if (!diffs.length && !refs.length) continue;
  lines.push(`## ${st}`, '');
  for (const k of diffs) { changed++; lines.push(`- **${k}**`, `  - before:${show(before[st][k])}`, `  - after:${show(after[st][k])}`); }
  if (refs.length) lines.push(`- **Reference contacts a new client gets** (new):${show(refs)}`);
  lines.push('');
}
lines.splice(3, 0, `${touched} states differ: ${common.length} changes shared by five or more states, then ${changed} particular to one state.`, '');
console.log(lines.join('\n'));
