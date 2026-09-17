/**
 * Extracts the Drive grant-knowledge folder into one bundle the knowledge base can
 * load, and a report of everything a person has to rule on first.
 *
 * Run:  node scripts/gk-extract.mjs --src "<…/Operations/grant-knowledge>" [--live-deadlines dump.json]
 *
 *   in   _FEDERAL.yaml, states/XX.yaml (56), states/XX.md (the prose companions)
 *        server/nsgp-verified.json       the 2026-08-08 web check, compared and folded in
 *        server/intake-state-config.json the client page's registration wording
 *        server/intake-documents.json    the client page's upload keys
 *        scripts/gk-rulings.json         Stuart's rulings, and facts no parser can lift from prose
 *        --live-deadlines                a saved GET /api/precall/deadlines (rows edited by hand live nowhere else)
 *   out  server/grant-knowledge-seed.json   the bundle, parents before children
 *        docs/gk-import-report.md           what disagreed, what could not be parsed
 *
 * The YAML is read with its comments, because the comments carry facts: every
 * passed deadline explains itself in one ("PASSED", "news-sourced", "time-of-day not
 * stated"), and a cap's comment says which year it is from. A field's trailing comment
 * becomes field_notes[field]; nothing is dropped on the floor.
 *
 * What the YAML states imports as verified by the audit that stamped the file. What
 * is older, flagged, or parsed out of free text imports unverified, so it waits in the
 * queue for a person instead of reaching a client. Prose companions older than the
 * 2026-08-11 audit are never imported as verified: NY.md still says "Grants Gateway".
 *
 * Every record carries an import_key, which is what makes loading it twice safe.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { JURISDICTIONS, parseData, slugKey, SCHEMAS } from '../server/grant-knowledge-kinds.js';
import { zonedInstant } from '../server/grant-knowledge.js';

// ── Arguments ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const SRC = arg('--src').replace(/\/$/, '');
const OUT = arg('--out') || new URL('../server/grant-knowledge-seed.json', import.meta.url).pathname;
const REPORT = arg('--report') || new URL('../docs/gk-import-report.md', import.meta.url).pathname;
const LIVE = arg('--live-deadlines');
const TODAY = arg('--today') || new Date().toISOString().slice(0, 10);
if (!SRC || !existsSync(`${SRC}/_FEDERAL.yaml`)) {
  console.error('usage: node scripts/gk-extract.mjs --src "<path to Operations/grant-knowledge>" [--live-deadlines dump.json]');
  process.exit(2);
}
const repoJson = rel => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const VERIFIED = repoJson('server/nsgp-verified.json');
const STATE_CONFIG = repoJson('server/intake-state-config.json');
const DOCUMENTS = repoJson('server/intake-documents.json');
const RULINGS = existsSync(new URL('./gk-rulings.json', import.meta.url)) ? repoJson('scripts/gk-rulings.json') : { records: [], skip: [], patch: {} };

const AUDIT_DATE = '2026-08-11';
// The zone of each capital: what "5:00 PM" on a state's grants page means.
const TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise',
  IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago',
  OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago',
  TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver', DC: 'America/New_York', PR: 'America/Puerto_Rico', GU: 'Pacific/Guam', VI: 'America/St_Thomas',
  AS: 'Pacific/Pago_Pago', MP: 'Pacific/Saipan', US: 'America/New_York',
};
const OTHER_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'];
const BASELINE_KEYS = ['sam_uei', 'ij', 'vuln_assessment', 'mission_letterhead', 'irs_501c3'];
const UNKNOWN = v => typeof v === 'string' && /^(unknown_needs_research|verify|unknown|tbd)$/i.test(v.trim());

// ── Output ────────────────────────────────────────────────────────────────────

const records = [];
const byKey = new Map();
const ruledKeys = new Set(); // records a ruling has spoken on: the comparisons below leave their status alone
const report = { applied: [], rulings: [], overlay: [], prose: [], intake: [], live: [], contacts: [], unknowns: [], trimmed: [], skipped: [] };

/** Makes the data fit its schema: a string over its limit is cut and kept whole in extra. */
function fit(kind, data, where) {
  let d = JSON.parse(JSON.stringify(data));
  for (let pass = 0; pass < 6; pass++) {
    const r = SCHEMAS[kind].safeParse(d);
    if (r.success) return r.data;
    const tooBig = r.error.issues.filter(i => i.code === 'too_big' && i.type === 'string' && i.path.length === 1);
    if (!tooBig.length) break;
    for (const i of tooBig) {
      const f = i.path[0];
      d.extra = { ...(d.extra || {}), [`full_${f}`]: d[f] };
      d[f] = `${d[f].slice(0, i.maximum - 1)}…`;
      report.trimmed.push(`${where}: \`${f}\` cut to ${i.maximum} characters (the whole text is in extra.full_${f})`);
    }
  }
  return parseData(kind, d); // throws with the field named
}

function add(rec) {
  if ((RULINGS.skip || []).includes(rec.import_key)) { report.skipped.push(`${rec.import_key}: skipped by ruling`); return null; }
  if (byKey.has(rec.import_key)) throw new Error(`duplicate import_key ${rec.import_key}`);
  const patch = (RULINGS.patch || {})[rec.import_key];
  if (patch) {
    rec.data = { ...rec.data, ...patch.data };
    ruledKeys.add(rec.import_key);
    for (const f of ['status', 'key', 'verified_by', 'verified_on', 'source_url']) if (patch[f]) rec[f] = patch[f];
    report.applied.push(`${rec.import_key}: patched (${patch.why || 'no reason given'})`);
  }
  const data = fit(rec.kind, clean(rec.data), rec.import_key);
  const out = {
    import_key: rec.import_key, jurisdiction: rec.jurisdiction, kind: rec.kind, parent: rec.parent || null, key: rec.key, data,
    status: rec.status === 'verified' ? 'verified' : 'unverified',
    verified_by: rec.status === 'verified' ? (rec.verified_by || `NPSA audit ${AUDIT_DATE}`) : '',
    verified_at: rec.status === 'verified' ? `${rec.verified_on || AUDIT_DATE}T12:00:00.000Z` : null,
    source_url: rec.source_url || '', sort_order: rec.sort_order || 0,
  };
  records.push(out); byKey.set(out.import_key, out);
  return out;
}

function clean(v) {
  if (Array.isArray(v)) return v.map(clean).filter(x => x !== undefined);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = clean(x); if (c !== undefined && !(c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length)) o[k] = c; }
    return o;
  }
  if (v === null || v === undefined || v === '') return undefined;
  return typeof v === 'string' ? v.trim() : v;
}

// ── YAML with its comments ────────────────────────────────────────────────────

const commentText = c => (c || '').split('\n').map(s => s.replace(/^\s*#?\s?/, '').trim()).filter(Boolean).join(' ');

/** A map node as { values, notes }: each key's plain value, and each key's trailing comment. */
function readMap(node) {
  const values = {}, notes = {}, nodes = {};
  if (!isMap(node)) return { values, notes, nodes };
  for (const pair of node.items) {
    const k = String(pair.key?.value ?? pair.key);
    values[k] = pair.value?.toJSON ? pair.value.toJSON() : pair.value;
    nodes[k] = pair.value;
    const c = commentText(pair.value?.comment);
    if (c) notes[k] = c;
  }
  return { values, notes, nodes };
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstUrl = s => (String(s || '').match(/https?:\/\/[^\s)"'>\]]+/) || [''])[0].replace(/[.,;]+$/, '');
const firstDollars = s => { const m = String(s || '').match(/\$\s?([\d,]+(?:\.\d+)?)(\s?[MK])?/i); if (!m) return undefined; const n = Number(m[1].replace(/,/g, '')); return m[2] ? n * (/m/i.test(m[2]) ? 1e6 : 1e3) : n; };

// ── Deadlines ─────────────────────────────────────────────────────────────────

/** An ISO datetime with its offset, as the wall-clock date, time and zone it names. */
function wallClock(isoWithOffset, state, where) {
  const m = String(isoWithOffset).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:\d{2}|Z)$/);
  if (!m) return null;
  const [, date, hh, mm] = m;
  const instant = Date.parse(isoWithOffset);
  const time = `${hh}:${mm}`;
  for (const tz of [TZ[state], ...OTHER_ZONES]) {
    // :59 seconds in the source lands inside the same minute; compare to the minute.
    if (tz && Math.abs(zonedInstant(date, time, tz) - instant) < 60000) return { date, time, tz };
  }
  report.rulings.push(`${where}: the offset in \`${isoWithOffset}\` matches no US zone for that date; imported in ${TZ[state]} as written. Check the time.`);
  return { date, time, tz: TZ[state] };
}

function federalFiscalYear(date) {
  if (date >= '2026-06-24') return 2026;
  if (date >= '2025-07-28') return 2025;
  return Number(date.slice(0, 4));
}

// ── Contacts out of free text ─────────────────────────────────────────────────

const EMAIL = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:1-)?\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}/;
const NOT_A_PERSON = /grants?|section|office|management|nsgp|bureau|main|inbox|help ?desk|unit|division|program|agency|preparedness|administration|updates|list|submissions?|salesforce|general|line\b/i;
const DOUBT = /reconfirm|\bconfirm\b|unconfirmed|no longer|verify|conflict|stale|unreliable|typo|not on (the )?(current|public)|does not resolve/i;

function splitTop(s, sep) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

export function parseContacts(raw) {
  const out = [];
  for (const seg of splitTop(String(raw || ''), ';')) {
    const remarks = [...seg.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map(m => m[1].trim()).filter(r => !/^\d{3}$/.test(r));
    let rest = seg;
    for (const r of remarks) rest = rest.replace(`(${r})`, ' ');
    const email = (rest.match(EMAIL) || [''])[0];
    const phone = (seg.match(PHONE) || [''])[0];
    let head = rest.split(/<|—| - /)[0];
    if (email) head = head.split(email)[0];
    if (phone) head = head.split(phone)[0];
    head = head.replace(/\s+/g, ' ').replace(/[\s,:/<>—-]+$/g, '').trim();
    const mainLine = /^(agency )?main$/i.test(head);
    head = head.replace(/^(and|cc|submissions?|updates list|program inbox|program mailbox|main|agency main)\b[:\s]*/i, '').trim();
    // "2026 RFA designated contact: Jason Tillou, …" names the person after the colon.
    const afterColon = head.includes(':') ? head.slice(head.lastIndexOf(':') + 1).trim() : '';
    if (afterColon && /^[A-Z][\w.'-]+ [A-Z]/.test(afterColon)) head = afterColon;
    // A remark about an address that has moved belongs to the contact before it.
    if (/\bold\b|still shows/i.test(head) && out.length) { out[out.length - 1].warning = [out[out.length - 1].warning, seg].filter(Boolean).join(' · '); continue; }
    if (mainLine && !head) head = 'Main line';
    const [first, ...others] = head.split(',').map(x => x.trim()).filter(Boolean);
    const isPerson = first && /^[A-Z][\w.'-]+(?: [A-Z][\w.'-]*){1,3}$/.test(first) && !NOT_A_PERSON.test(first) && !first.split(' ').some(t => /^[A-Z]{2,}$/.test(t));
    const c = {};
    if (isPerson) { c.name = first; if (others.length) c.role = others.join(', '); } else if (head) c.org = head;
    if (email) c.email = email;
    if (phone) c.phone = phone;
    const doubt = remarks.filter(r => DOUBT.test(r)), plain = remarks.filter(r => !DOUBT.test(r));
    if (DOUBT.test(rest.replace(email, ''))) doubt.push(rest.replace(email, '').trim());
    if (doubt.length) c.warning = doubt.join(' · ');
    if (plain.length) c.notes = plain.join(' · ');
    if (!email && !phone && !isPerson) {
      // A trailing remark, not a contact of its own: keep it with the one before.
      if (out.length) out[out.length - 1].notes = [out[out.length - 1].notes, seg].filter(Boolean).join(' · ');
      else if (head) out.push({ org: head.slice(0, 200), notes: seg });
      continue;
    }
    out.push(c);
  }
  return out;
}

// ── Federal ───────────────────────────────────────────────────────────────────

function extractFederal() {
  const doc = parseDocument(readFileSync(`${SRC}/_FEDERAL.yaml`, 'utf8'));
  const { values: f } = readMap(doc.contents);
  const cc = f.current_cycle || {};
  const src = f.authoritative_page || '';

  add({ import_key: 'j:US', jurisdiction: 'US', kind: 'jurisdiction', key: 'US', status: 'verified', source_url: src, data: {
    name: JURISDICTIONS.US, saa: f.administered_by, authoritative_page: src, default_tz: TZ.US, ij_form: cc.ij_form,
    summary_md: f.cadence_warning, extra: { last_verified_note: f.last_verified },
  } });
  add({ import_key: 'p:US:NSGP', jurisdiction: 'US', kind: 'program', key: 'NSGP', status: 'verified', source_url: src, data: {
    name: f.program, type: 'federal', administered_by: f.administered_by, status: 'active',
    locations_max: num(cc.locations_max), cap_per_location: num(cc.award_cap_per_location), cap_per_applicant: num(cc.award_cap_per_applicant),
    ma_pct: num(cc.ma_allowed_pct), cost_match: cc.cost_share, pop_months: 36, pop_note: [cc.period_of_performance, cc.pop_note].filter(Boolean).join(' '),
    deadline_authority: 'Each SAA sets its own subapplicant deadline, always earlier than the FEMA date',
    field_notes: clean({ locations_max: readMap(doc.get('current_cycle', true)).notes.locations_max, ma_pct: readMap(doc.get('current_cycle', true)).notes.ma_allowed_pct }),
  } });

  const u = f.universal_requirements || {};
  const baseline = [
    ['sam_uei', 'registration', 'SAM.gov registration + active UEI', 'client', { lead_time_days: 28, hard_gate: true, notes: u.sam_uei, phase: 'before_nofo' }],
    ['ij', 'document', 'Investment Justification (IJ)', 'npsa', { format: 'FEMA fillable PDF, Adobe Acrobat', notes: 'One per physical address, up to 3 sites. Current-FY form only.', phase: 'application' }],
    ['vuln_assessment', 'document', 'Vulnerability assessment', 'client', { format: 'PDF', notes: u.vulnerability_assessment, phase: 'before_nofo' }],
    ['mission_letterhead', 'document', 'Mission statement on letterhead', 'client', { format: 'PDF on letterhead', notes: u.mission_statement, phase: 'application' }],
    ['irs_501c3', 'document', 'IRS 501(c)(3) determination letter', 'client', { format: 'PDF', notes: u.eligible_entities, phase: 'application' }],
  ];
  baseline.forEach(([key, req_type, label, owner, more], i) => add({
    import_key: `r:US:NSGP:${key}`, jurisdiction: 'US', kind: 'requirement', parent: 'p:US:NSGP', key, status: 'verified', sort_order: i,
    data: { req_type, label, owner, ...more },
  }));

  (f.ij_handling_rules || []).forEach((rule, i) => note('US', null, {
    category: 'gotcha', severity: /auto-?disqualif|reject|will not be accepted|auto-?deny/i.test(rule) ? 'auto_disqualifier' : 'caution',
    title: `IJ handling: ${rule.split(/[.—(]/)[0].slice(0, 120)}`, body_md: rule, phase: 'application',
  }, 'verified', i));
  if (u.section_889) note('US', null, { category: 'eligibility', title: 'Section 889: surveillance and telecom equipment', body_md: u.section_889, phase: 'application' }, 'verified');
  if (u.scoring) note('US', null, { category: 'scoring', title: 'Scoring: org-type multiplier and first-time bonus', body_md: u.scoring, phase: 'application' }, 'verified');
  (f.watch_items || []).forEach(w => note('US', null, { category: 'watch_item', title: w.split(/[:—.]/)[0].slice(0, 150), body_md: w }, 'verified'));

  for (const h of f.fy_history || []) {
    const current = h.fy === cc.fy;
    add({ import_key: `c:US:NSGP:${h.fy}`, jurisdiction: 'US', kind: 'cycle', parent: 'p:US:NSGP', key: String(h.fy), status: 'verified', source_url: (f.sources || [])[0] || src, data: {
      fiscal_year: h.fy, label: `FY${h.fy}`, status: current && cc.status === 'closed' ? 'awaiting_awards' : 'awarded', nofo_date: h.nofo, total_funding: num(h.total),
      nsgp_s_funding: current ? num(cc.nsgp_s) : undefined, nsgp_ua_funding: current ? num(cc.nsgp_ua) : undefined,
      pop_start: current ? '2026-09-01' : undefined, pop_end: current ? '2029-08-31' : undefined, confidence: 'confirmed',
      notes: [h.notes, current ? `Awards expected: ${cc.awards_expected}` : ''].filter(Boolean).join(' '),
      extra: clean({ cap_per_site: h.cap_per_site }),
    } });
    const due = current ? cc.federal_deadline : (h.federal_deadline ? `${h.federal_deadline}T23:59:00-04:00` : '');
    const w = due && wallClock(due, 'US', `US FY${h.fy}`);
    if (w) add({ import_key: `d:US:NSGP:${h.fy}:fema`, jurisdiction: 'US', kind: 'deadline', parent: `c:US:NSGP:${h.fy}`, key: 'fema', status: 'verified', data: {
      label: 'SAA applications due to FEMA', due_date: w.date, due_time: w.time, tz: w.tz, deadline_kind: 'fema', binding: false, confidence: 'confirmed',
      note: 'Every state deadline lands earlier than this one.',
    } });
  }
  (f.sources || []).forEach(url => source('US', null, url));
}

// ── Notes and sources ─────────────────────────────────────────────────────────

const taken = new Set();
function uniqueKey(prefix, stem) {
  let key = stem, n = 2;
  while (taken.has(`${prefix}:${key}`)) key = `${stem.slice(0, 56)}-${n++}`;
  taken.add(`${prefix}:${key}`);
  return key;
}

function note(state, program, data, status = 'unverified', sort_order = 0, extra) {
  const parent = program ? `p:${state}:${program}` : null;
  const key = uniqueKey(`n:${state}:${program || ''}`, slugKey(data.title));
  // A short note that names a fatal mistake is a stopper; a whole section that mentions
  // one in passing is only critical, or the "read first" list becomes the whole page.
  if (!data.severity && /auto-?(deny|denied|disqualif)|locked out|locks the applicant out|will not be accepted|no second window|missed the cycle|automatic(ally)? (deny|reject)/i.test(`${data.title} ${data.body_md || ''}`)) {
    data.severity = (data.body_md || '').length < 700 ? 'auto_disqualifier' : 'critical';
  }
  return add({ import_key: `n:${state}:${program || '-'}:${key}`, jurisdiction: state, kind: 'note', parent, key, status, sort_order, data: { ...data, extra } });
}

function source(state, program, url, covers) {
  const u = firstUrl(url);
  if (!u) return null;
  const key = uniqueKey(`s:${state}`, slugKey(u.replace(/^https?:\/\/(www\.)?/, '')));
  return add({ import_key: `s:${state}:${key}`, jurisdiction: state, kind: 'source', parent: program ? `p:${state}:${program}` : null, key, status: 'verified', data: { url: u, accessed: AUDIT_DATE, covers } });
}

// ── One state ─────────────────────────────────────────────────────────────────

const TOP_NOTES = {
  state_program_watch: ['watch_item', 'State program watch'], state_program_note: ['history', 'State program status'],
  adjacent_funding_note: ['process', 'Adjacent funding'], adjacent_program_note: ['process', 'Adjacent program'],
  fy26_notes: ['history', 'FY26 notes'], fy25_award_status: ['history', 'FY25 award status'], notes: ['process', 'State notes'],
  fy26_technical_assistance: ['process', 'FY26 technical assistance'],
};

function extractState(state) {
  const doc = parseDocument(readFileSync(`${SRC}/states/${state}.yaml`, 'utf8'));
  if (doc.errors.length) throw new Error(`${state}.yaml: ${doc.errors[0].message}`);
  const { values: y, notes: topNotes } = readMap(doc.contents);
  if (y.state !== state) report.rulings.push(`${state}.yaml says \`state: ${y.state}\`; imported as ${state}.`);
  const fileVerified = /NPSA audit 2026-08-11/.test(y.verified_by || '') ? 'verified' : 'unverified';
  const mainSource = firstUrl((y.sources || [])[0]);
  const header = commentText(doc.commentBefore).replace(/^Structured submission requirements[^.]*\.\s*/i, '').replace(/^[—-]\s*/, '');

  add({ import_key: `j:${state}`, jurisdiction: state, kind: 'jurisdiction', key: state, status: fileVerified, source_url: mainSource, data: {
    name: JURISDICTIONS[state], saa: y.saa, saa_short: y.saa_short, participates_federal_nsgp: y.participates_federal_nsgp,
    urban_areas: (y.urban_areas || []).map(String), partner: y.partner || undefined, cycle_status: typeof y.cycle_status === 'string' ? y.cycle_status.slice(0, 200) : undefined,
    cycle_timing_note: typeof y.cycle_status === 'string' && y.cycle_status.length > 200 ? y.cycle_status : undefined,
    post_award_note: y.post_award_note || undefined, default_tz: TZ[state], summary_md: header || undefined,
    field_notes: clean({ saa: topNotes.saa, urban_areas: topNotes.urban_areas, partner: topNotes.partner }),
    extra: clean({ last_verified_note: y.last_verified, verified_by: y.verified_by }),
  } });

  for (const [k, [category, title]] of Object.entries(TOP_NOTES)) if (typeof y[k] === 'string' && y[k].trim()) note(state, null, { category, title, body_md: y[k] }, fileVerified);
  for (const e of y.eligibility_notes || []) note(state, null, { category: 'eligibility', title: String(e).split(/[.(—]/)[0].slice(0, 150), body_md: String(e), phase: 'application' }, fileVerified);
  for (const g of y.gotchas || []) note(state, null, { category: 'gotcha', title: String(g).split(/[.(—:]/)[0].slice(0, 150), body_md: String(g) }, fileVerified);
  for (const p of y.cisa_psa_contacts || []) contact(state, null, { name: p.name, area: p.area, email: p.email, phone: p.phone, org: 'CISA', contact_kind: 'cisa_psa', role: 'Protective Security Advisor' }, fileVerified);
  (y.sources || []).forEach(u => source(state, null, u));

  const programsNode = doc.get('programs', true);
  const seenEmails = new Set();
  (isSeq(programsNode) ? programsNode.items : []).forEach((node, index) => extractProgram(state, node, index, { fileVerified, y, seenEmails }));

  // NSGP-UA files "reference, don't duplicate": with no list of its own it takes NSGP-S's.
  const mine = records.filter(r => r.jurisdiction === state && r.kind === 'program');
  for (const p of mine) {
    const hasOwn = records.some(r => r.parent === p.import_key && r.kind === 'requirement');
    if (!hasOwn && p.key !== 'NSGP-S' && p.data.type === 'federal' && mine.some(x => x.key === 'NSGP-S')) p.data.inherits_from = 'NSGP-S';
  }

  if (y.fy26_allocations && typeof y.fy26_allocations === 'object') {
    for (const [k, v] of Object.entries(y.fy26_allocations)) {
      const ua = k.match(/^nsgp_ua_?(.*)$/i);
      const prog = byKey.get(`p:${state}:${ua ? 'NSGP-UA' : 'NSGP-S'}`);
      const cyc = prog && ensureCycle(state, prog.key, 2026, fileVerified, 'federal');
      if (!cyc || !num(v)) { report.rulings.push(`${state}: fy26_allocations.${k} = ${v} found no FY2026 cycle to land on.`); continue; }
      if (ua) cyc.data.ua_allocations = { ...(cyc.data.ua_allocations || {}), [ua[1] || 'urban area']: v }; else cyc.data.state_allocation = v;
    }
  }
}

function contact(state, program, data, status, raw) {
  const label = data.name || data.org || data.email || data.role || 'contact';
  const key = uniqueKey(`k:${state}:${program || ''}`, slugKey(label));
  return add({ import_key: `k:${state}:${program || '-'}:${key}`, jurisdiction: state, kind: 'contact', parent: program ? `p:${state}:${program}` : null, key, status, data: { ...data, last_confirmed: status === 'verified' ? AUDIT_DATE : undefined, extra: clean({ raw }) } });
}

function extractProgram(state, node, index, { fileVerified, seenEmails }) {
  const { values: p, notes: n, nodes } = readMap(node);
  const id = String(p.id);
  const where = `${state}/${id}`;
  const pk = `p:${state}:${id}`;
  const unknowns = [];
  const known = (field, v, as = x => x) => { if (UNKNOWN(v)) { unknowns.push(field); return undefined; } return v === null || v === undefined ? undefined : as(v); };
  const asNum = (field, v) => known(field, v, x => { if (typeof x === 'number') return x; (n[field] = [n[field], `Source says: ${x}`].filter(Boolean).join(' · ')); return undefined; });

  const sub = p.submission || {};
  const override = (VERIFIED.program_overrides || {})[state];
  const fieldNotes = {};
  const mapNote = (from, to) => { if (n[from]) fieldNotes[to] = n[from]; };
  [['locations_max', 'locations_max'], ['award_cap_per_location', 'cap_per_location'], ['award_cap_per_applicant', 'cap_per_applicant'], ['ma_allowed_pct', 'ma_pct'],
    ['cost_match', 'cost_match'], ['period_of_performance_months', 'pop_months'], ['application_window_days', 'window_days'], ['deadline_authority', 'deadline_authority'],
    ['stackable_with_federal', 'stackable'], ['administered_by', 'administered_by'], ['name', 'name']].forEach(([a, b]) => mapNote(a, b));

  const data = {
    name: p.name, type: p.type === 'state' ? 'state' : 'federal', administered_by: known('administered_by', p.administered_by), status: 'active',
    locations_max: asNum('locations_max', p.locations_max), cap_per_location: asNum('award_cap_per_location', p.award_cap_per_location),
    cap_per_applicant: asNum('award_cap_per_applicant', p.award_cap_per_applicant), ma_pct: asNum('ma_allowed_pct', p.ma_allowed_pct),
    cost_match: known('cost_match', p.cost_match, String), pop_months: UNKNOWN(p.period_of_performance_months) ? undefined : num(p.period_of_performance_months),
    window_days: num(p.application_window_days), deadline_authority: known('deadline_authority', p.deadline_authority, String),
    stackable: p.stackable_with_federal === true || p.stackable_with_federal === false ? p.stackable_with_federal : (p.stackable_with_federal === undefined ? undefined : 'verify'),
    submission: clean({ method: known('submission.method', sub.method, String), target: known('submission.target', sub.target, String), url: firstUrl(sub.target) || undefined, package_note: sub.package_note }),
    notes_md: p.notes, eligible_costs: p.eligible_costs || (Array.isArray(p.eligible_uses) ? p.eligible_uses.map(x => `- ${x}`).join('\n') : undefined),
    availability_note: [p.status_note, p.cycle_status].filter(Boolean).join(' ') || undefined,
    extra: clean({ application_window: typeof p.application_window_days === 'string' && !UNKNOWN(p.application_window_days) ? p.application_window_days : p.application_window }),
  };
  if (n.period_of_performance_months) fieldNotes.pop_months = n.period_of_performance_months;
  for (const k of ['cap_per_location', 'cap_per_applicant', 'locations_max', 'ma_pct']) { const src = { cap_per_location: 'award_cap_per_location', cap_per_applicant: 'award_cap_per_applicant', locations_max: 'locations_max', ma_pct: 'ma_allowed_pct' }[k]; if (n[src]) fieldNotes[k] = n[src]; }

  if (override && data.type === 'state') {
    if (override.dormant) { data.status = 'dormant'; data.availability_note = [data.availability_note, override.why].filter(Boolean).join(' '); report.overlay.push(`${where}: marked **dormant** from the 2026-08-08 web check (${override.why})`); }
    if (override.unconfirmed) { data.status = 'unconfirmed'; data.availability_note = [data.availability_note, override.why].filter(Boolean).join(' '); report.overlay.push(`${where}: marked **unconfirmed** from the web check (${override.why})`); }
    if (override.exclusiveWith?.includes(id)) { data.exclusive_with = override.exclusiveWith.filter(x => x !== id); report.overlay.push(`${where}: \`exclusive_with\` ${data.exclusive_with.join(', ')} from the web check`); }
    if (override.administeredBy && !String(data.administered_by || '').includes(override.administeredBy)) report.overlay.push(`${where}: web check says administered by **${override.administeredBy}**; Drive says **${data.administered_by || 'nothing'}**. Drive kept. Rule on it.`);
  }
  data.field_notes = clean(fieldNotes);

  add({ import_key: pk, jurisdiction: state, kind: 'program', key: id, status: fileVerified, sort_order: index, source_url: firstUrl(sub.target), data });

  const important = unknowns.filter(f => !['application_window_days', 'period_of_performance_months'].includes(f));
  if (p.stackable_with_federal !== undefined && data.stackable === 'verify') important.push('stackable_with_federal');
  if (important.length) {
    report.unknowns.push(`${where}: ${important.join(', ')}`);
    note(state, id, { category: 'open_question', title: `${id}: still unknown`, body_md: `The Drive file marks these as needing research: ${important.map(f => `\`${f}\``).join(', ')}.` }, 'unverified');
  }
  for (const w of p.watch_items || []) note(state, id, { category: 'watch_item', title: String(w).split(/[:—.(]/)[0].slice(0, 150), body_md: String(w) }, fileVerified);
  if (p.cycle_timing_note) note(state, id, { category: 'process', title: `${id}: when the next cycle is expected`, body_md: p.cycle_timing_note, phase: 'before_nofo' }, fileVerified);

  // Requirements
  const reqs = (listNode, req_type) => (isSeq(listNode) ? listNode.items : []).forEach((item, i) => {
    const { values: r } = readMap(item);
    const rid = String(r.id);
    const gate = r.hard_gate === true || r.hard_gate === false ? r.hard_gate : undefined;
    const extra = clean({ required_by: r.required_by, saa_collects: r.saa_collects, npsa_position: r.npsa_position });
    const lead = num(r.lead_time_days);
    add({ import_key: `r:${state}:${id}:${rid}`, jurisdiction: state, kind: 'requirement', parent: pk, key: rid, status: fileVerified, sort_order: i, data: {
      req_type, label: String(r.label), owner: r.owner === 'npsa' ? 'npsa' : 'client', lead_time_days: lead, hard_gate: gate, format: r.format ? String(r.format) : undefined,
      notes: r.notes, phase: req_type === 'registration' ? (lead >= 45 || /before the (federal )?nofo|months before/i.test(r.notes || '') ? 'before_nofo' : 'registration') : 'application',
      url: firstUrl(r.notes) || undefined, extra,
      field_notes: clean({ lead_time_days: UNKNOWN(r.lead_time_days) ? 'Unknown; needs research' : undefined, hard_gate: UNKNOWN(r.hard_gate) ? 'Unknown; needs research' : undefined }),
    } });
    if (r.deadline_fixed) stagedDeadline(state, id, data.type, r.deadline_fixed, { key: slugKey(rid), label: String(r.label).slice(0, 190), deadline_kind: rid === 'noi' ? 'noi' : 'registration', stage_order: 0, comment: '' }, fileVerified);
  });
  reqs(nodes.registration, 'registration');
  reqs(nodes.required_documents, 'document');

  // Cycle and deadline
  if (p.deadline_fixed && !UNKNOWN(p.deadline_fixed)) stagedDeadline(state, id, data.type, p.deadline_fixed, { key: 'final', label: 'Application due', deadline_kind: data.type === 'state' ? 'state_program' : 'sub_applicant', stage_order: 1, comment: n.deadline_fixed || '' }, fileVerified);
  else if (UNKNOWN(p.deadline_fixed)) unknowns.push('deadline_fixed');

  const alloc = p.fy26_state_target_allocation ?? p.fy26_allocation;
  if (alloc !== undefined) {
    const cyc = ensureCycle(state, id, 2026, fileVerified, data.type);
    cyc.data.state_allocation = num(alloc) ?? firstDollars(alloc);
    if (typeof alloc === 'string') cyc.data.notes = [cyc.data.notes, alloc].filter(Boolean).join(' ');
    if (/medium confidence|verify/i.test(String(alloc))) { cyc.status = 'unverified'; cyc.verified_by = ''; cyc.verified_at = null; }
  }

  // Contacts
  const lines = [[p.contact, ''], [p.contact_secondary, 'secondary'], [p.contact_backup, 'backup']].filter(([s]) => s && !UNKNOWN(s));
  for (const [line, role] of lines) {
    const parsed = parseContacts(line);
    parsed.forEach((c, i) => {
      const seen = (c.email || `${c.phone}|${c.name || ''}`).toLowerCase();
      if ((c.email || c.phone) && seenEmails.has(seen)) return;
      seenEmails.add(seen);
      if (i === 0 && (p.contact_warning || p.contact_note)) c.warning = [c.warning, p.contact_warning, p.contact_note].filter(Boolean).join(' · ');
      const clean_ = Boolean(c.email || c.phone) && !c.warning;
      const c2 = { ...c, contact_kind: data.type === 'state' ? 'program' : 'saa', is_primary: i === 0 && !role && index === 0 ? true : undefined, notes: [c.notes, role ? `${role} contact` : ''].filter(Boolean).join(' · ') || undefined };
      contact(state, data.type === 'state' ? id : null, c2, clean_ ? fileVerified : 'unverified', line);
      report.contacts.push(`| ${where} | ${c.name || ''} | ${c.role || c.org || ''} | ${c.email || ''} | ${c.phone || ''} | ${c.warning ? '⚠️ ' + c.warning.slice(0, 80) : ''} |`);
    });
  }
}

function ensureCycle(state, program, fy, status, type) {
  const ck = `c:${state}:${program}:${fy}`;
  return byKey.get(ck) || add({ import_key: ck, jurisdiction: state, kind: 'cycle', parent: `p:${state}:${program}`, key: String(fy), status, data: { fiscal_year: fy, label: type === 'state' ? `${fy} round` : `FY${fy}` } });
}

function stagedDeadline(state, program, type, isoWithOffset, { key, label, deadline_kind, stage_order, comment }, fileVerified) {
  const where = `${state}/${program}`;
  const w = wallClock(isoWithOffset, state, where);
  if (!w) { report.rulings.push(`${where}: \`deadline_fixed: ${isoWithOffset}\` is not a datetime; not imported.`); return; }
  const fy = type === 'state' ? Number(w.date.slice(0, 4)) : federalFiscalYear(w.date);
  const cyc = ensureCycle(state, program, fy, fileVerified, type);
  const passed = w.date < TODAY;
  if (passed && !cyc.data.status) cyc.data.status = 'closed'; else if (!passed) cyc.data.status = 'open';
  const noTime = /time(-of-day)? not stated|time not (given|published)|no time/i.test(comment);
  const soft = /news-sourced|med(ium)?-high|unconfirmed|not corroborated|verify|approx/i.test(comment);
  const downgrade = (VERIFIED.downgrades || []).find(d => d.state === state && d.date === w.date && (d.program === 'federal' ? type === 'federal' : d.program === program));
  if (downgrade) report.overlay.push(`${where}: ${w.date} downgraded to "verify" by the web check (${downgrade.why})`);
  add({ import_key: `d:${state}:${program}:${fy}:${key}`, jurisdiction: state, kind: 'deadline', parent: cyc.import_key, key, status: soft || downgrade ? 'unverified' : fileVerified, data: {
    label, stage_order, due_date: w.date, due_time: noTime ? undefined : w.time, tz: w.tz, deadline_kind, binding: true,
    confidence: soft || downgrade ? 'illustrative' : 'confirmed', note: [comment, downgrade ? `Web check ${VERIFIED._checked}: ${downgrade.why}` : ''].filter(Boolean).join(' ') || undefined,
  } });
}

// ── Prose companions ──────────────────────────────────────────────────────────

const SKIP_SECTION = /^(state administrative agency|application portal|program parameters|required (application )?documents|registration|cost share|related resources|sources|administering agency|nsgp-ua \(urban area\)|what is)/i;
const SECTION_CATEGORY = [
  [/gotcha/i, 'gotcha', 'bullets'], [/prohibited|does not cover/i, 'prohibited_cost', 'section'], [/eligib/i, 'eligibility', 'section'], [/scoring/i, 'scoring', 'section'],
  [/timeline|deadline|histor|allocation|funding|award information|cycle data/i, 'history', 'section'],
  [/./, 'process', 'section'],
];

function extractProse(state) {
  const path = `${SRC}/states/${state}.md`;
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const lastVerified = (text.match(/\*\*Last Verified:\*\*\s*(.+)/) || [, 'not stated'])[1].trim();
  const fresh = /2026-08-11|August 2026|September 2026/i.test(lastVerified);
  const status = fresh ? 'verified' : 'unverified';
  const stale = ['Grants Gateway', 'TDEM Grants Portal', 'DEMES'].filter(t => text.includes(t));
  report.prose.push(`- **${state}.md**: last verified "${lastVerified}". Imported as **${status}**.${stale.length ? ` Contains terms the audit retired: ${stale.map(s => `"${s}"`).join(', ')}.` : ''}`);

  const programs = records.filter(r => r.jurisdiction === state && r.kind === 'program');
  const programFor = heading => (programs.find(p => p.data.type === 'state' && new RegExp(`\\b${p.key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(heading)) || {}).key || null;

  let part = null, imported = 0;
  const sections = text.split(/^(?=#{2,3} )/m).slice(1);
  for (const sec of sections) {
    const [headLine, ...bodyLines] = sec.split('\n');
    const level = headLine.match(/^#+/)[0].length;
    const heading = headLine.replace(/^#+\s*/, '').trim();
    const body = bodyLines.join('\n').replace(/^---\s*$/gm, '').trim();
    if (level === 2 && /^part \d/i.test(heading)) { part = programFor(heading); continue; }
    if (level === 2) part = programFor(heading) || (/^part/i.test(heading) ? part : null);
    const program = programFor(heading) || part;
    if (!body || SKIP_SECTION.test(heading.replace(/^nsgp(-il)? /i, ''))) continue;
    const [, category, mode] = SECTION_CATEGORY.find(([re]) => re.test(heading));
    const extra = { prose_source: `${state}.md, "${heading}" (last verified ${lastVerified})` };
    if (mode === 'bullets') {
      const bullets = body.split(/^(?=- )/m).map(b => b.trim()).filter(b => b.startsWith('- '));
      for (const b of bullets) {
        const textOnly = b.replace(/^- /, '').replace(/\n\s+/g, ' ');
        const bold = textOnly.match(/^\*\*(.+?)\*\*/);
        note(state, program, { category, title: (bold ? bold[1] : textOnly.split(/[.:—]/)[0]).replace(/[.:]$/, '').slice(0, 190), body_md: textOnly, severity: undefined }, status, imported, extra);
        imported++;
      }
    } else {
      note(state, program, { category, title: heading.slice(0, 190), body_md: body, phase: /pre-nofo/i.test(heading) ? 'before_nofo' : undefined }, status, imported, extra);
      imported++;
    }
  }
  report.prose[report.prose.length - 1] += ` ${imported} notes.`;
}

// ── The web check, the intake files, the live table ───────────────────────────

function compareOverlay() {
  const deadlines = records.filter(r => r.kind === 'deadline');
  const programOf = r => r.import_key.split(':')[2];
  const has = (state, program, date) => deadlines.find(d => d.jurisdiction === state && d.data.due_date === date && (program === 'federal' || program === 'federal-noi' ? /^NSGP/.test(programOf(d)) : programOf(d) === program));

  for (const c of VERIFIED.corrections || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.now)) { report.rulings.push(`**${c.state}/${c.program}**: the web check says this cycle is "${c.now}" (${c.was}). ${c.why} The bundle labels a state program's round by the year its deadline falls in; say if this one should read otherwise.`); continue; }
    if (has(c.state, c.program, c.now)) { report.overlay.push(`${c.state}/${c.program} FY${c.cycle}: web check's ${c.now} agrees with Drive.`); continue; }
    const drive = deadlines.filter(d => d.jurisdiction === c.state && (c.program === 'federal' ? /^NSGP/.test(programOf(d)) : programOf(d) === c.program)).map(d => `${d.data.due_date} (${d.data.label})`);
    report.rulings.push(`**${c.state}/${c.program} FY${c.cycle}**: the web check moved this to **${c.now}** (was ${c.was}); Drive has ${drive.length ? drive.join(', ') : 'no date'}. Web check's reason: ${c.why} Sources: ${(c.sources || []).join('; ')}. **Neither is imported as verified until ruled.**`);
    for (const d of deadlines.filter(d => d.jurisdiction === c.state && d.data.due_date === c.was && !ruledKeys.has(d.import_key))) { d.status = 'unverified'; d.verified_by = ''; d.verified_at = null; d.data.confidence = 'illustrative'; }
  }
  for (const a of VERIFIED.additions || []) {
    if (has(a.state, a.program, a.date)) continue;
    const id = a.program === 'federal' || a.program === 'federal-noi' ? 'NSGP-S' : a.program;
    const prog = byKey.get(`p:${a.state}:${id}`);
    if (!prog) { report.overlay.push(`${a.state}/${a.program}: the web check added ${a.date} but Drive has no program \`${id}\`. Not imported. ${a.note || ''}`); continue; }
    // A state round is labelled the way the web check labels it (Tennessee's 2026-27
    // round is "2027"), per Stuart's ruling of 2026-09-17.
    const fy = prog.data.type === 'state' ? (a.cycle || Number(a.date.slice(0, 4))) : federalFiscalYear(a.date);
    const cyc = ensureCycle(a.state, id, fy, 'unverified', prog.data.type);
    let key = a.program === 'federal-noi' ? 'noi' : 'web-check';
    for (let n = 2; byKey.has(`d:${a.state}:${id}:${fy}:${key}`); n++) key = `web-check-${n}`;
    add({ import_key: `d:${a.state}:${id}:${fy}:${key}`, jurisdiction: a.state, kind: 'deadline', parent: cyc.import_key, key, status: 'unverified', source_url: firstUrl(a.source), data: {
      label: a.program === 'federal-noi' ? 'Notice of intent due' : 'Application due', due_date: a.date, tz: TZ[a.state], deadline_kind: a.program === 'federal-noi' ? 'noi' : (prog.data.type === 'state' ? 'state_program' : 'sub_applicant'),
      confidence: a.confidence === 'confirmed' ? 'confirmed' : 'illustrative', note: [`From the ${VERIFIED._checked} web check; not in the Drive file.`, a.note, a.source].filter(Boolean).join(' '),
    } });
    report.overlay.push(`${a.state}/${id}: added ${a.date} from the web check (unverified). Drive does not have it.`);
  }
  for (const u of VERIFIED.unresolved || []) {
    const state = (u.what.match(/^([A-Z]{2})\b/) || [])[1];
    if (!state || !JURISDICTIONS[state]) continue;
    note(state, null, { category: 'open_question', title: u.what, body_md: `${u.concern}\n\n**What was done:** ${u.action}` }, 'unverified');
  }
}

const words = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'hard', 'gate', 'registration', 'account', 'client', 'portal'].includes(w)));
function overlap(a, b) { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); }

function compareIntake() {
  for (const [state, cfg] of Object.entries(STATE_CONFIG.states || {})) {
    const regs = records.filter(r => r.jurisdiction === state && r.kind === 'requirement' && r.data.req_type === 'registration');
    if (!regs.length) continue;
    for (const entry of cfg.registration || []) {
      const label = typeof entry === 'string' ? entry.replace(/\s*[—-]\s*hard gate\s*$/i, '') : entry.label;
      const hint = typeof entry === 'string' ? '' : (entry.note || '');
      if (/^SAM\.gov/i.test(label)) continue;
      const best = regs.map(r => [overlap(label, `${r.data.label} ${r.data.notes || ''} ${r.key}`), r]).sort((a, b) => b[0] - a[0])[0];
      if (best && best[0] >= 0.5) {
        if (!best[1].data.client_label) { best[1].data.client_label = label.slice(0, 300); if (hint) best[1].data.client_hint = hint; }
      } else report.intake.push(`- **${state}**: the client page shows "${label}" but no Drive registration step matches it. Drive has: ${regs.filter(r => r.key !== 'sam_uei').map(r => `"${r.data.label}"`).join('; ') || 'only SAM.gov'}.`);
    }
  }
  // Upload keys: which document requirement each intake upload row stands for.
  const DOC_FOR = { up_mission: 'mission_letterhead', up_501c3: 'irs_501c3', up_va: 'vuln_assessment', up_bios: 'bios_resumes', up_gov_resolution: 'governing_body_resolution', up_tx_payee: 'tx_payee_forms' };
  const apply = (req, d) => { Object.assign(req.data, clean({ upload_key: d.key, task_stem: d.task, ready_label: d.ready, client_label: req.data.client_label || d.label, client_hint: req.data.client_hint || d.hint })); };
  for (const d of DOCUMENTS.standard || []) for (const r of records.filter(r => r.kind === 'requirement' && r.key === DOC_FOR[d.key] && (r.jurisdiction === 'US' || d.key === 'up_bios'))) apply(r, d);
  for (const [state, list] of Object.entries(DOCUMENTS.by_state || {})) for (const d of list) {
    const r = records.find(r => r.jurisdiction === state && r.kind === 'requirement' && r.key === DOC_FOR[d.key]);
    if (r) apply(r, d); else report.intake.push(`- **${state}**: upload row \`${d.key}\` ("${d.label}") matches no Drive document.`);
  }
  for (const bp of DOCUMENTS.by_program || []) {
    const docs = records.filter(r => r.kind === 'requirement' && r.parent === `p:${bp.state}:${bp.program}` && r.data.req_type === 'document');
    for (const d of bp.documents) {
      const best = docs.map(r => [Math.max(overlap(d.label, r.data.label), r.key === DOC_FOR[d.key] ? 1 : 0), r]).sort((a, b) => b[0] - a[0])[0];
      if (best && best[0] >= 0.5 && !best[1].data.upload_key) apply(best[1], d);
      else report.intake.push(`- **${bp.state}/${bp.program}**: upload row \`${d.key}\` ("${d.label}") matches no Drive document for that program. It stays in intake-documents.json until someone adds it here.`);
    }
  }
}

function compareLive() {
  if (!LIVE) { report.live.push('No `--live-deadlines` dump was given, so the production deadline table was **not** read. It holds past-cycle dates and hand-typed rows that exist nowhere else: save `GET /api/precall/deadlines` to a file and run again before loading.'); return; }
  const rows = (JSON.parse(readFileSync(LIVE, 'utf8')).deadlines || []);
  let agreed = 0;
  for (const row of rows.filter(r => r.deadline)) {
    const date = String(row.deadline).slice(0, 10);
    const mine = records.filter(r => r.kind === 'deadline' && r.jurisdiction === row.state);
    if (mine.some(d => d.data.due_date === date)) { agreed++; continue; }
    const federal = /^federal/.test(row.program);
    const programs = records.filter(r => r.kind === 'program' && r.jurisdiction === row.state);
    const prog = federal ? (programs.find(p => p.key === 'NSGP-S') || programs.find(p => p.data.type === 'federal')) : programs.find(p => p.key === row.program);
    if (!prog) { report.live.push(`- ${row.state} / ${row.program} / ${row.cycle_year}: **${date}** is in the live table, but the bundle has no such program. Not imported.`); continue; }
    const others = mine.filter(d => d.import_key.split(':')[2] === prog.key && d.import_key.split(':')[3] === String(row.cycle_year) && (d.data.deadline_kind || '') !== 'noi').map(d => d.data.due_date);
    const byHand = row.layer === 'manual' && row.confidence === 'confirmed';
    const cyc = ensureCycle(row.state, prog.key, row.cycle_year, byHand ? 'verified' : 'unverified', prog.data.type);
    if (date < TODAY && !cyc.data.status) cyc.data.status = 'closed';
    let key = row.program === 'federal-noi' ? 'noi' : 'final';
    for (let n = 2; byKey.has(`d:${row.state}:${prog.key}:${row.cycle_year}:${key}`); n++) key = `${row.layer === 'manual' ? 'typed' : 'table'}-${n}`;
    add({ import_key: `d:${row.state}:${prog.key}:${row.cycle_year}:${key}`, jurisdiction: row.state, kind: 'deadline', parent: cyc.import_key, key,
      status: byHand ? 'verified' : 'unverified', verified_by: 'Sales Toolbox deadline table (typed by hand)', verified_on: String(row.updated_at).slice(0, 10), source_url: firstUrl(row.source),
      data: { label: row.program === 'federal-noi' ? 'Notice of intent due' : 'Application due', stage_order: 1, due_date: date, tz: TZ[row.state],
        deadline_kind: row.kind === 'fema' ? 'fema' : (row.program === 'federal-noi' ? 'noi' : (federal ? 'sub_applicant' : 'state_program')), binding: true,
        confidence: row.confidence === 'confirmed' ? 'confirmed' : 'illustrative',
        note: [row.note, row.source && !firstUrl(row.source) ? `Source: ${row.source}` : '', `From the Sales Toolbox deadline table (${row.layer}).`].filter(Boolean).join(' ') } });
    if (others.length) report.rulings.push(`**${row.state}/${prog.key} FY${row.cycle_year}**: the Sales Toolbox table says **${date}** (${row.layer}); Drive says **${[...new Set(others)].join(', ')}**. Both imported; see section 5.`);
    report.live.push(`- ${row.state} / ${row.program} / ${row.cycle_year}: **${date}** came from the live table (${row.layer}, ${row.confidence}), imported ${byHand ? 'verified (typed by hand)' : 'unverified'}.${others.length ? ` Drive has **${[...new Set(others)].join(', ')}** for the same program and cycle: they disagree, and both are in the bundle. Rule on it.` : ''}`);
  }
  report.live.unshift(`${rows.length} rows read; ${agreed} already had a matching date in the bundle. The rest:`, '');
}

// ── Run ───────────────────────────────────────────────────────────────────────

extractFederal();
const stateFiles = readdirSync(`${SRC}/states`).filter(f => /^[A-Z]{2}\.yaml$/.test(f)).map(f => f.slice(0, 2)).sort();
for (const f of readdirSync(`${SRC}/states`)) if (!/^[A-Z]{2}\.(yaml|md)$/.test(f)) report.skipped.push(`states/${f}: not a state file, not read`);
for (const st of stateFiles) { if (!JURISDICTIONS[st]) { report.skipped.push(`states/${st}.yaml: not a jurisdiction`); continue; } extractState(st); }
for (const st of stateFiles) extractProse(st);
compareOverlay();
compareIntake();
compareLive();
for (const r of RULINGS.records || []) { add(r); report.applied.push(`${r.import_key}: added${r.why ? ` (${r.why})` : ''}`); }

// Text rulings: a settled fact that Drive states the old way in several places.
for (const rule of RULINGS.replace || []) {
  const re = rule.from_regex ? new RegExp(rule.from_regex, 'g') : null;
  let hits = 0;
  const walk = v => (typeof v === 'string' ? (() => { const out = re ? v.replace(re, rule.to) : v.split(rule.from).join(rule.to); if (out !== v) hits++; return out; })()
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  for (const r of records.filter(r => r.jurisdiction === rule.jurisdiction)) r.data = walk(r.data);
  report.applied.push(`${rule.jurisdiction}: "${rule.from || rule.from_regex}" → "${rule.to}" in ${hits} place(s) (${rule.why || 'no reason given'})`);
}

// Parents before children, and every parent present.
const order = { jurisdiction: 0, program: 1, requirement: 2, cycle: 2, deadline: 3, contact: 4, note: 4, source: 4 };
records.sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || order[a.kind] - order[b.kind]);
for (const r of records) {
  r.data = fit(r.kind, clean(r.data), r.import_key);
  if (r.parent && !byKey.has(r.parent)) throw new Error(`${r.import_key}: parent ${r.parent} is not in the bundle`);
}

const ruled = RULINGS.ruled || [];
report.rulings = report.rulings.filter(line => !ruled.some(x => line.includes(x.match)));
for (const x of ruled) report.applied.push(`Ruled: ${x.ruling}`);

const missing = Object.keys(JURISDICTIONS).filter(c => !records.some(r => r.import_key === `j:${c}`));
const count = (f) => records.filter(f).length;
const bundle = { _what: 'Grant knowledge seed: extracted from the Drive grant-knowledge folder by scripts/gk-extract.mjs. Loaded with scripts/gk-load.mjs; do not edit by hand, change the source or add a ruling and re-extract.', extracted_on: TODAY, audit: AUDIT_DATE, records };
writeFileSync(OUT, `${JSON.stringify(bundle, null, 1)}\n`);

const kinds = ['jurisdiction', 'program', 'requirement', 'cycle', 'deadline', 'contact', 'note', 'source'];
const section = (title, lines, empty) => `## ${title}\n\n${lines.length ? lines.join('\n') : empty}\n`;
writeFileSync(REPORT, `# Grant knowledge import report

Extracted ${TODAY} from the Drive \`grant-knowledge\` folder (audit of ${AUDIT_DATE}). This is what the extractor could not settle by itself. **Section 1 needs a ruling before the load**; the rest is for review.

| | |
| :-- | --: |
${kinds.map(k => `| ${k} | ${count(r => r.kind === k)} |`).join('\n')}
| **records** | **${records.length}** |
| imported as verified | ${count(r => r.status === 'verified')} |
| imported as unverified (waits in the queue) | ${count(r => r.status === 'unverified')} |
| jurisdictions with no file | ${missing.filter(c => c !== 'US').join(', ') || 'none'} |

A ruling goes in \`scripts/gk-rulings.json\` (\`records\` to add, \`patch\` to change one by its import key, \`skip\` to leave one out), then re-run the extractor.

${section('1. Needs a ruling', report.rulings.map(x => `- ${x}`), 'Nothing.')}
${section('Rulings already applied (scripts/gk-rulings.json)', report.applied.map(x => `- ${x}`), 'None yet.')}
${section('2. The 2026-08-08 web check against Drive', report.overlay.map(x => `- ${x}`), 'No differences.')}
${section('3. Prose companions', report.prose, 'None found.')}
Prose sections that restate what the YAML holds (SAA, portal, program parameters, required documents, registration, cost share) were not imported; the YAML is the authority for those. Timelines, allocations and history were imported as \`history\` notes so the past cycles in them are not lost; the research pass turns them into cycles.

${section('4. The client intake page against Drive', report.intake, 'Every registration line and upload row on the client page matched a Drive record.')}
${section('5. The live deadline table', report.live, '')}
${section('6. Still unknown in Drive (each became an open question)', report.unknowns.map(x => `- ${x}`), 'Nothing.')}
${section('7. Contacts parsed out of free text', ['| Where | Name | Role or org | Email | Phone | Flag |', '| :-- | :-- | :-- | :-- | :-- | :-- |', ...report.contacts], '')}
A contact with a flag, or with neither an email nor a phone, imports unverified. Each keeps its original line in \`extra.raw\`.

${section('8. Text cut to fit', report.trimmed.map(x => `- ${x}`), 'Nothing was cut.')}
${section('9. Not read', report.skipped.map(x => `- ${x}`), 'Nothing skipped.')}`);

console.log(`${records.length} records (${count(r => r.status === 'verified')} verified, ${count(r => r.status === 'unverified')} unverified) across ${new Set(records.map(r => r.jurisdiction)).size} jurisdictions`);
console.log(kinds.map(k => `${k} ${count(r => r.kind === k)}`).join(' · '));
console.log(`${report.rulings.length} item(s) need a ruling → ${REPORT}`);
console.log(`bundle → ${OUT}`);
