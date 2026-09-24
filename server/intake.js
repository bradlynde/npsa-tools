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
import { driveConfigured, uploadToDrive } from './drive.js';
import { mailConfigured, sendWelcome, senderFor } from './mail.js';
import { splitKeys, keyMatches, nameFor, mayAssertActor, cleanActor } from './mcp.js';
import { UPLOAD_MAX_BYTES, sniffUploadType, safeFilename, rawUploadBody, uploadBodyError, readMultipart } from './uploads.js';
import { knowledgeFor as knowledgeOf, combinedStateProgram } from './knowledge.js';

// A state's facts from the grant knowledge base (server/knowledge.js). A code it does
// not hold gets nothing rather than a guess: the federal baseline and no state program.
const NO_STATE = { saa: '', saaShort: '', federal: { perSite: null, locationsMax: null, programs: [] }, programs: [], registration: {}, documents: {}, contacts: [] };
const knowledgeFor = state => knowledgeOf(state) || NO_STATE;

// Re-exported because the upload rules were this module's before the grant
// knowledge tab needed the same ones; callers and the smoke test still ask here.
export { UPLOAD_MAX_BYTES, sniffUploadType };

// ── Catalog ───────────────────────────────────────────────────────────────────

const CATALOG = JSON.parse(readFileSync(new URL('./intake-questions.json', import.meta.url), 'utf8'));
const CHECKLIST_META = JSON.parse(readFileSync(new URL('./intake-checklist.json', import.meta.url), 'utf8')).tasks;
const NPSA_TEAM = JSON.parse(readFileSync(new URL('./intake-team.json', import.meta.url), 'utf8')).contacts;
const DOC_KEY_RE = /^up_[a-z0-9_]{2,40}$/;

/**
 * Documents the team has marked as received outside the form (a client often emails a file
 * instead of uploading it): { key: { at, by, note } }. Received counts the same as an upload
 * everywhere: the dialog, the client's Documents tab and the submission box.
 */
export function receivedFor(client) {
  const r = client.documents_received;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}

/**
 * The program codes a client is applying to: their stored applications, or, before
 * those are set, any state program the program_track text names.
 */
function appliedCodes(client, kb) {
  const apps = Array.isArray(client.applications) ? client.applications.filter(a => a.status !== 'withdrawn') : null;
  if (apps) return apps.map(a => a.program);
  const track = String(client.program_track || '').toLowerCase();
  return track ? kb.programs.filter(p => track.includes(p.code.toLowerCase()) || (p.name && track.includes(p.name.toLowerCase()))).map(p => p.code) : [];
}

/**
 * The upload rows a client's Documents tab shows: their own list if the team changed
 * it, else their state program's list where that program has its own (California's
 * CSNSGP), else the federal list: the US baseline in the state's wording plus what
 * the state adds. From the knowledge base's verified records.
 */
export function documentsFor(client) {
  if (Array.isArray(client.documents)) return client.documents.map(d => ({ ...d, source: d.source || 'custom' }));
  const st = String(client.state || '').toUpperCase();
  const kb = knowledgeFor(st);
  const codes = appliedCodes(client, kb);
  const own = kb.programs.find(p => codes.includes(p.code) && kb.documents[p.code]);
  const fed = [...codes, 'NSGP-S', ...kb.federal.programs.map(p => p.code)].find(c => kb.federal.programs.some(p => p.code === c) && kb.documents[c]);
  return (kb.documents[own ? own.code : fed || 'baseline'] || []).map(d => ({ ...d }));
}
const npsaChecklistKey = k => { const m = /^chk_(?:a\d{1,2}_)?(?:status|due|who|note)_(.+)$/.exec(k); return !!m && CHECKLIST_META[m[1]]?.owner === 'npsa'; };
const CHECKLIST_STATUSES = ['Not started', 'In progress', 'Completed', 'Not applicable'];
const CHECKLIST_STEM_SET = new Set(CATALOG.questions.filter(q => q.key.startsWith('chk_status_')).map(q => q.key.slice('chk_status_'.length)));
function validDocument(d, label) {
  const key = String(d?.key || '').trim().toLowerCase();
  if (!DOC_KEY_RE.test(key)) throw new BadRequest(`${label}.key must look like up_something (letters, digits, underscores)`);
  const text = String(d.label || '').trim().slice(0, 140);
  if (!text) throw new BadRequest(`${label}.label cannot be blank`);
  const out = { key, label: text, hint: String(d.hint || '').trim().slice(0, 80) };
  if (d.ready) out.ready = String(d.ready).trim().slice(0, 100);
  if (d.task) { const t = String(d.task).trim(); if (!CHECKLIST_STEM_SET.has(t)) throw new BadRequest(`${label}.task "${t}" is not a checklist task`); out.task = t; }
  if (d.source && ['standard', 'state', 'program', 'custom'].includes(d.source)) out.source = d.source;
  return out;
}
// Some MCP clients hand an array argument over as its JSON text. Take that as the array it is,
// rather than refusing a write the caller got right.
function asArray(list) {
  if (typeof list !== 'string') return list;
  const t = list.trim();
  if (!t.startsWith('[')) return list;
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : list; } catch { return list; }
}
function validDocuments(list, field) {
  list = asArray(list);
  if (list === undefined) return undefined;
  if (list === null) return null;
  if (!Array.isArray(list)) throw new BadRequest(`${field} must be an array (or null to go back to the defaults)`);
  const out = list.map((d, i) => validDocument(d, `${field}[${i}]`));
  const seen = new Set();
  for (const d of out) { if (seen.has(d.key)) throw new BadRequest(`${field}: "${d.key}" appears twice`); seen.add(d.key); }
  return out;
}

export const QUESTIONS = CATALOG.questions;
const PRIMARY_CONTACT_KEYS = ['q_1_1_1', 'q_1_1_2', 'q_1_1_3', 'q_1_1_4']; // name, title, email, phone
const QUESTION_BY_KEY = new Map(QUESTIONS.map(q => [q.key, q]));
export const SECTIONS = [...new Set(QUESTIONS.map(q => q.section))];

// The sections the client is actually asked to fill, for the headline count. The
// wish list is excluded on purpose: 363 of its keys are legitimately blank for a
// one-site client with six interests, so counting them makes every client look
// half done. It gets its own per-section line instead.
// Programs is a grow-as-you-go list (20 slots, most unused), so like the wish list
// it is reported as a count of rows rather than folded into the core total.
const CORE_SECTIONS = new Set(SECTIONS.filter(s => /^[1-5]\. /.test(s) || s === 'Locations' || s === 'Uploads'));
const PROGRAM_SLOTS = [...new Set(QUESTIONS.filter(q => /^prog\d+_/.test(q.key)).map(q => Number(q.key.match(/^prog(\d+)_/)[1])))];
const CORE_KEYS = QUESTIONS.filter(q => CORE_SECTIONS.has(q.section) && q.kind !== 'meta' && !q.key.endsWith('_infra')).map(q => q.key); // *_infra is NPSA research, not a client answer
const CHECKLIST_STEMS = QUESTIONS.filter(q => q.key.startsWith('chk_status_')).map(q => q.key.slice('chk_status_'.length));

// The wish list is 3 facilities × 20 items × 6 fields, and a client only ever
// fills the items they care about. So the measure is: which items carry a
// priority (the `_int` select, 1 = fund first), and how many of that item's five
// detail fields (currently have, what & why, where, quantity, cost) are answered.
const WISH_DETAILS = ['cur', 'desc', 'where', 'qty', 'cost'];
// Federal NSGP caps (FY26): $200,000 per site, three sites, so $600,000 per applicant.
// M&A may be up to 5% of the award; the default line is 5% of the items requested.
export const BUDGET = { siteCap: 200000, maRate: 0.05 };
/** "$52,000", "18000", "about 18k" → 52000 / 18000 / 18000; anything without a number → null. */
export function parseMoney(v) {
  const t = String(v || '').replace(/,/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|m)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1000 : 1000000;
  return Math.round(n);
}
const WISH_FACILITIES = [1, 2, 3].map(n => ({
  n,
  items: QUESTIONS.filter(q => q.key.startsWith(`wl_f${n}_`) && q.key.endsWith('_int')).map(q => ({
    stem: q.key.slice(`wl_f${n}_`.length, -'_int'.length),
    label: q.label.replace(/\s+—\s+Priority.*$/i, ''),
  })),
}));

/**
 * What a "State Program" site can draw on, with its caps (null = not published).
 * Every live state program counts, only one of a set the state awards only one of
 * (New Jersey's THE or SP).
 */
export function stateProgram(state) {
  return combinedStateProgram(knowledgeFor(state).programs);
}
/** The federal per-site cap in this state: the state's own where it sets a lower one (Kansas), else the NOFO's. */
export function federalSiteCap(state) {
  return knowledgeFor(state).federal.perSite || BUDGET.siteCap;
}
const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
function capText(sp) {
  if (!sp) return '—';
  const parts = [sp.perSite ? `${usd(sp.perSite)} per site` : '', sp.perApplicant ? `${usd(sp.perApplicant)} per applicant` : ''].filter(Boolean);
  return `${sp.acronym}: ${parts.join(', ') || 'not published'}`;
}
/**
 * The client page's state block: SAA, registration steps, caps. `codes` are the
 * programs the client is applying to; a state program's own registration steps show
 * only for a client applying to it.
 */
export function stateConfig(state, codes = []) {
  const st = String(state || '').toUpperCase();
  const kb = knowledgeFor(st);
  const sp = stateProgram(st);
  const keys = [...(kb.federal.programs.length ? kb.federal.programs.map(p => p.code) : ['baseline']), ...kb.programs.filter(p => codes.includes(p.code)).map(p => p.code)];
  const seen = new Set();
  const registration = keys.flatMap(k => kb.registration[k] || []).filter(r => (seen.has(r.key) ? false : seen.add(r.key)))
    .map(({ label, hard_gate, note }) => ({ label, hard_gate, ...(note ? { note } : {}) }));
  const perSite = kb.federal.perSite || BUDGET.siteCap;
  return {
    saa: kb.saaShort || kb.saa || st,
    programs: [...kb.federal.programs.map(p => `Federal ${p.code}`), ...kb.programs.map(p => p.name)],
    registration,
    perSiteCap: `${usd(perSite)} per site${kb.federal.locationsMax ? ` · up to ${kb.federal.locationsMax} sites` : ''}`,
    stateCap: capText(sp),
    federalSiteCap: perSite,
    // Most states take estimates, so quotes are a submission requirement only where the program says so.
    quotes_required: kb.programs.some(p => p.quotes_required && codes.includes(p.code)),
    stateProgram: sp,
  };
}

/**
 * The SAA and program people a new client starts with on the Contacts tab (read-only
 * for them): verified contacts with an email, the state's own and those of the
 * programs being written, primary first, at most four.
 */
export function referenceContactsFor(state, codes = []) {
  const kb = knowledgeFor(state);
  const programs = new Set([...kb.federal.programs.map(p => p.code), ...codes]);
  const seen = new Set();
  return kb.contacts
    .filter(c => ['saa', 'program', 'cisa_psa'].includes(c.kind) && (!c.program || programs.has(c.program)))
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .filter(c => (seen.has(c.email.toLowerCase()) ? false : seen.add(c.email.toLowerCase())))
    .slice(0, 4)
    .map(c => ({ name: c.name, email: c.email, role: c.role || '', phone: c.phone || '', side: 'reference' }));
}

// ── Applications ──────────────────────────────────────────────────────────────
// What NPSA is writing for a client: one row per application (program, cycle, the
// sites it covers, where it stands). Set by the team at kickoff; the client page
// shows them in its header and builds site caps from them. A client without a
// stored list gets one derived from the Locations tab's "Programs applying".
export const FEDERAL_PROGRAMS = [
  { code: 'NSGP-S', name: 'Federal NSGP-S (outside an urban area)', kind: 'federal' },
  { code: 'NSGP-UA', name: 'Federal NSGP-UA (urban area)', kind: 'federal' },
];
export const APPLICATION_STATUSES = ['active', 'planned', 'submitted', 'awarded', 'not_awarded', 'withdrawn'];
const CAP_STATUSES = new Set(['active', 'submitted', 'awarded']); // planned work gets its own wish list later, not a share of today's
export function programsFor(state) {
  const st = knowledgeFor(state).programs.map(p => ({ code: p.code, name: p.name, kind: 'state', per_site: p.per_site, per_applicant: p.per_applicant }));
  return [...FEDERAL_PROGRAMS.map(p => ({ ...p, per_site: federalSiteCap(state), per_applicant: null })), ...st];
}
function validApplications(list, state) {
  if (list === undefined) return undefined;
  if (list === null) return null;
  list = asArray(list);
  if (!Array.isArray(list)) throw new BadRequest('applications must be an array (or null to clear)');
  if (list.length > 6) throw new BadRequest('applications: at most 6');
  const programs = programsFor(state);
  const used = new Set(list.map(a => String(a?.id || '')).filter(id => /^a\d{1,2}$/.test(id)));
  if (used.size !== list.filter(a => /^a\d{1,2}$/.test(String(a?.id || ''))).length) throw new BadRequest('applications: ids must be unique');
  let next = Math.max(0, ...[...used].map(id => Number(id.slice(1)))) + 1;
  return list.map((a, i) => {
    const label = `applications[${i}]`;
    const prog = programs.find(p => p.code.toLowerCase() === String(a?.program || '').trim().toLowerCase());
    if (!prog) throw new BadRequest(`${label}.program must be one of ${programs.map(p => p.code).join(', ')}`);
    const sites = a.sites === undefined ? [1] : a.sites;
    if (!Array.isArray(sites) || !sites.length || sites.some(n => ![1, 2, 3].includes(n)) || new Set(sites).size !== sites.length) throw new BadRequest(`${label}.sites must list site numbers 1–3`);
    const status = a.status === undefined ? 'active' : String(a.status);
    if (!APPLICATION_STATUSES.includes(status)) throw new BadRequest(`${label}.status must be one of ${APPLICATION_STATUSES.join(', ')}`);
    let id = String(a.id || '');
    if (!/^a\d{1,2}$/.test(id)) { id = `a${next++}`; used.add(id); }
    return { id, program: prog.code, cycle: String(a.cycle || '').trim().slice(0, 24), sites: [...sites].sort(), status };
  });
}
/** The stored list with names filled in, or one derived from the Locations tab (derived: true). */
export function applicationsFor(client, val = () => '') {
  const programs = programsFor(client.state);
  const view = a => { const p = programs.find(x => x.code === a.program) || { name: a.program, kind: /^NSGP-(S|UA)$/.test(a.program) || a.program === 'NSGP' ? 'federal' : 'state' };
    return { ...a, name: p.name, kind: p.kind, per_site: p.per_site ?? (p.kind === 'federal' ? BUDGET.siteCap : null), per_applicant: p.per_applicant ?? null, label: [a.program, a.cycle].filter(Boolean).join(' ') }; };
  if (Array.isArray(client.applications)) return client.applications.map(view);
  const sp = programsFor(client.state).find(p => p.kind === 'state');
  const groups = new Map();
  for (const n of [1, 2, 3]) {
    const v = val(`loc${n}_programs`);
    if (!v) continue;
    const codes = [];
    if (/NSGP-UA/.test(v)) codes.push('NSGP-UA'); else if (/NSGP-S/.test(v)) codes.push('NSGP-S'); else if (/Federal/.test(v)) codes.push('NSGP');
    if (/State/.test(v) && sp) codes.push(sp.code);
    for (const c of codes) groups.set(c, [...(groups.get(c) || []), n]);
  }
  return [...groups].map(([program, sites], i) => ({ ...view({ id: `a${i + 1}`, program, cycle: '', sites, status: 'active' }), ...(program === 'NSGP' ? { name: 'Federal NSGP' } : {}), derived: true }));
}
/** What one application's own wish list may ask for: per site, and in total (a state per-applicant cap holds the total). */
export function applicationCap(app) {
  const perSite = app.per_site ?? (app.kind === 'federal' ? BUDGET.siteCap : null);
  const perApp = app.per_applicant ?? null;
  const total = perSite ? Math.min(perApp ?? Infinity, perSite * app.sites.length) : (perApp ?? 0);
  return { per_site: perSite ?? perApp ?? 0, cap: total, cap_unknown: !perSite && !perApp };
}
/** The key prefix for an application's wish list: a1 keeps the catalog's wl_f<n>_ keys, the rest are wl_<id>_f<n>_. */
export function wishPrefix(id) { return !id || id === 'a1' ? 'wl_' : `wl_${id}_`; }
const WL_APP_KEY_RE = /^wl_(a(?:[2-9]|[1-9]\d))_(f[123]_.+)$/;
// The checklist splits. A second application is an add-on rather than a second engagement: it needs
// its own wish list, budget, IJ and submission, while the prep, the drafting and the review with the
// client are done once. Vendor quotes stay shared because we usually work from estimates.
export const PER_APPLICATION_STEMS = [
  'wish_list_ideation_per_location', 'wish_list_prioritization', 'wish_list_budget_finalization',
  'investment_justification_ij_prepar', 'final_review_edits', 'assemble_submission_package', 'submit_application',
];
/** The checklist key prefix for an application: a1 keeps chk_status_…, the rest are chk_<id>_status_…. */
export function checklistPrefix(id) { return !id || id === 'a1' ? 'chk_' : `chk_${id}_`; }
const CHK_APP_KEY_RE = /^chk_(a(?:[2-9]|[1-9]\d))_((?:status|due|who|note)_.+)$/;
/** A per-application wish list or checklist key answers to the same catalog question as its plain twin. */
function catalogKey(k) {
  const w = WL_APP_KEY_RE.exec(k); if (w) return `wl_${w[2]}`;
  const c = CHK_APP_KEY_RE.exec(k); if (c) return `chk_${c[2]}`;
  return k;
}

/** Locations-tab style "programs" string for a site, from stored applications ("None" when nothing covers it). */
function siteProgramsFromApplications(apps, n) {
  const live = apps.filter(a => CAP_STATUSES.has(a.status) && a.sites.includes(n));
  const fed = live.some(a => a.kind === 'federal'), st = live.some(a => a.kind === 'state');
  return fed && st ? 'Federal + State' : fed ? 'Federal' : st ? 'State Program' : 'None';
}

/**
 * What the applications being written could add up to. Each active site chooses
 * its programs on the Locations tab ("Federal NSGP-S", "Federal NSGP-UA", "State
 * Program", "Federal + State"; blank counts as federal). Federal is $200,000 a
 * site; the state program adds its per-site cap, held to its per-applicant cap
 * across sites (California: $250,000 a site, $500,000 an applicant). A state
 * program with only a per-applicant cap counts once, at the applicant level.
 */
export function capsFor(state, sites) {
  const sp = stateProgram(state);
  const siteCap = federalSiteCap(state);
  const out = { sites: [], federal: 0, state: 0, state_program: null, state_cap_unknown: false, assumed_federal: false };
  let statePerSite = 0, stateSites = 0;
  for (const site of sites) {
    const v = String(site.programs || '');
    const federal = !v || /Federal/.test(v);
    const stateOn = /State/.test(v);
    if (!v) out.assumed_federal = true;
    const cap = { facility: site.facility, programs: [federal ? 'NSGP' : null, stateOn && sp ? sp.acronym : null].filter(Boolean), federal: federal ? siteCap : 0, state: 0, assumed: !v };
    if (stateOn && sp) {
      stateSites++;
      if (sp.perSite) { cap.state = sp.perSite; statePerSite += sp.perSite; }
      else if (!sp.perApplicant) out.state_cap_unknown = true;
    }
    cap.cap = cap.federal + cap.state;
    out.sites.push(cap);
    out.federal += cap.federal;
  }
  if (stateSites) { out.state = sp.perApplicant ? Math.min(sp.perApplicant, statePerSite || sp.perApplicant) : statePerSite; out.state_program = sp.acronym; }
  out.cap = out.federal + out.state;
  return out;
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

const SIDES = ['client', 'npsa', 'reference']; // reference = helpful people outside NPSA and the client (SAA, CISA)
function validContact(c, label) {
  const email = String(c?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new BadRequest(`${label}.email is not an email address`);
  const side = c.side === undefined ? 'client' : String(c.side);
  if (!SIDES.includes(side)) throw new BadRequest(`${label}.side must be "client", "npsa" or "reference"`);
  return {
    name: String(c.name || '').trim().slice(0, 120), email, role: String(c.role || '').trim().slice(0, 120),
    phone: String(c.phone || '').trim().slice(0, 40), side, is_primary: Boolean(c.is_primary),
  };
}
function validContacts(list, field = 'contacts') {
  list = asArray(list);
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BadRequest(`${field} must be an array`);
  return list.map((c, i) => validContact(c, `${field}[${i}]`));
}

function validEmails(list, field) {
  list = asArray(list);
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
  const unknown = keys.filter(k => !QUESTION_BY_KEY.has(catalogKey(k)));
  if (unknown.length) throw new BadRequest(`Unknown intake keys: ${unknown.join(', ')}. Use the question catalog for the exact keys.`, { unknown_keys: unknown });
  const meta = allowMeta ? [] : keys.filter(k => QUESTION_BY_KEY.get(catalogKey(k)).kind === 'meta');
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

/** Headline counts. `applications` is how many applications carry their own copy of the per-application tasks (0 = one shared checklist). */
export function summarise(answers, applications = 0) {
  const val = k => answers.get(k)?.value || '';
  const core = CORE_KEYS.filter(k => val(k) !== '').length;
  const statuses = [...answers.keys()].filter(k => /^chk_(a\d{1,2}_)?status_/.test(k)).map(k => val(k));
  const checklist = statuses.filter(v => v === 'Completed').length;
  // "Not applicable" tasks leave the count rather than sit unfinished forever.
  const notApplicable = statuses.filter(v => v === 'Not applicable').length;
  const total = CHECKLIST_STEMS.length + Math.max(0, applications - 1) * PER_APPLICATION_STEMS.length;
  return { core: { answered: core, total: CORE_KEYS.length }, checklist: { completed: checklist, total: total - notApplicable, not_applicable: notApplicable } };
}
// What this client is actually asked, so the counts match their form: state-only fields drop out by
// state, Locations counts the sites in use (not all three slots; the research box and, once
// applications are set, the programs select are not the client's to fill), Uploads counts this
// client's Documents list (uploaded, or marked received by the team), and 3.6 counts once a
// program is listed, as on the page.
const STATE_ONLY = { q_1_3_4: ['TX', 'IL'], q_1_3_9: ['NY'] };
const LOC_FIELDS = ['name', 'addr', 'county', 'ownlease', 'year', 'historic', 'sqft', 'acreage', 'buildings', 'value'];
const PROGRESS_KEY_RE = /^(q_|loc\d_|up_|prog\d+_(name|unique)$)/;
export function progressFor(client, answered, uploaded = new Set()) {
  const has = k => answered.has(k);
  const st = String(client.state || '').toUpperCase();
  const stored = Array.isArray(client.applications) ? client.applications.filter(a => a.status !== 'withdrawn') : null;
  const programs = PROGRAM_SLOTS.some(n => has(`prog${n}_name`)), unique = PROGRAM_SLOTS.some(n => has(`prog${n}_unique`));
  const sections = [];
  for (const q of QUESTIONS) {
    if (!/^[1-5]\. /.test(q.section) || q.kind === 'meta' || (STATE_ONLY[q.key] && !STATE_ONLY[q.key].includes(st))) continue;
    let sec = sections.find(x => x.section === q.section);
    if (!sec) sections.push(sec = { section: q.section, answered: 0, total: 0 });
    sec.total++; if (has(q.key) || (q.key === 'q_3_2_3' && unique)) sec.answered++;
  }
  const community = sections.find(x => x.section.startsWith('3.'));
  if (community) { community.total++; if (programs) community.answered++; }
  const sites = new Set([1, ...(stored || []).flatMap(a => a.sites)]);
  for (const n of [2, 3]) if ([...LOC_FIELDS, 'programs'].some(f => has(`loc${n}_${f}`))) sites.add(n);
  const locKeys = [...sites].sort().flatMap(n => [...LOC_FIELDS, ...(stored ? [] : ['programs'])].map(f => `loc${n}_${f}`));
  sections.push({ section: 'Locations', answered: locKeys.filter(has).length, total: locKeys.length });
  const docs = documentsFor(client).map(d => d.key), received = receivedFor(client);
  sections.push({ section: 'Uploads', answered: docs.filter(k => has(k) || uploaded.has(k) || received[k]).length, total: docs.length });
  return { sections, core: { answered: sections.reduce((n, x) => n + x.answered, 0), total: sections.reduce((n, x) => n + x.total, 0) } };
}
const answeredSet = answers => new Set([...answers].filter(([k, a]) => a?.value && PROGRESS_KEY_RE.test(k)).map(([k]) => k));

/** How many checklist tasks a client has in total: the shared ones plus a copy of the split ones per application. */
export function checklistTotal(client) {
  const apps = Array.isArray(client.applications) ? client.applications.filter(a => a.status !== 'withdrawn').length : 0;
  return CHECKLIST_STEMS.length + Math.max(0, apps - 1) * PER_APPLICATION_STEMS.length;
}

function uploadView(u, slug, docs = []) {
  return {
    id: u.id, key: u.key, label: docs.find(d => d.key === u.key)?.label || QUESTION_BY_KEY.get(u.key)?.label || u.key, filename: u.filename, mime: u.mime, size_bytes: u.size_bytes,
    uploaded_by: u.uploaded_by, uploaded_at: u.uploaded_at, drive_url: u.drive_url || null,
    download_path: `/api/clients/${encodeURIComponent(slug)}/uploads/${u.id}`,
  };
}

function statusView(client, answers, base, uploads = []) {
  const val = k => answers.get(k)?.value || '';
  const progress = progressFor(client, answeredSet(answers), new Set(uploads.map(u => u.key)));
  const sections = SECTIONS.map(section => {
    const own = progress.sections.find(x => x.section === section);
    if (own) return own;
    const keys = QUESTIONS.filter(q => q.section === section && q.kind !== 'meta');
    return { section, answered: keys.filter(q => val(q.key) !== '').length, total: keys.length };
  });
  const wishFacilities = prefix => WISH_FACILITIES.map(f => {
    const items = f.items
      .map(it => {
        const priority = val(`${prefix}f${f.n}_${it.stem}_int`);
        if (!priority) return null;
        const answered = WISH_DETAILS.filter(d => val(`${prefix}f${f.n}_${it.stem}_${d}`) !== '').length;
        return { stem: it.stem, label: it.label, priority: Number(priority) || priority, answered, total: WISH_DETAILS.length };
      })
      .filter(Boolean)
      .sort((a, b) => (a.priority > b.priority ? 1 : a.priority < b.priority ? -1 : 0));
    const costed = items.map(it => ({ ...it, cost: parseMoney(val(`${prefix}f${f.n}_${it.stem}_cost`)) }));
    const itemsTotal = costed.reduce((n, it) => n + (it.cost || 0), 0);
    const maOn = val(`${prefix}f${f.n}_ma_on`) !== 'off';
    const maEntered = parseMoney(val(`${prefix}f${f.n}_ma_amount`));
    const ma = maOn ? (maEntered ?? Math.round(itemsTotal * BUDGET.maRate)) : 0;
    const total = itemsTotal + ma;
    return {
      facility: f.n, name: val(`loc${f.n}_name`), prioritized: items.length,
      details: { answered: items.reduce((n, it) => n + it.answered, 0), total: items.length * WISH_DETAILS.length },
      items: costed,
      budget: { items: itemsTotal, ma, ma_on: maOn, ma_default: maEntered === null, total, programs: val(`loc${f.n}_programs`), uncosted: costed.filter(it => it.cost === null).length },
    };
  });
  const wish_list = wishFacilities('wl_');
  // A site is in play once it has a name, an address or anything on its wish list.
  const applications = applicationsFor(client, val);
  const stored = Array.isArray(client.applications);
  if (stored) for (const f of wish_list) f.budget.programs = siteProgramsFromApplications(applications, f.facility);
  const active = wish_list.filter(f => f.facility === 1 || f.name || val(`loc${f.facility}_addr`) || f.prioritized > 0 || f.budget.items > 0 || (stored && applications.some(a => a.sites.includes(f.facility))));
  const caps = capsFor(client.state, active.map(f => ({ facility: f.facility, programs: f.budget.programs })));
  for (const f of wish_list) {
    const cap = caps.sites.find(x => x.facility === f.facility);
    f.budget.cap = cap ? cap.cap : 0; f.budget.programs = cap ? cap.programs : []; f.budget.cap_assumed = cap ? cap.assumed : false;
    f.budget.room = f.budget.cap - f.budget.total;
  }
  let requested = wish_list.reduce((n, f) => n + f.budget.total, 0);
  let budget = { requested, cap: caps.cap, room: caps.cap - requested, sites: active.length, federal: caps.federal, state: caps.state, state_program: caps.state_program, state_cap_unknown: caps.state_cap_unknown, assumed_federal: caps.assumed_federal };
  // One wish list per stored application (withdrawn ones drop out), each against its own caps.
  const wish_lists = stored ? applications.filter(a => a.status !== 'withdrawn').map(a => {
    const cap = applicationCap(a);
    const facilities = wishFacilities(wishPrefix(a.id)).filter(f => a.sites.includes(f.facility)).map(f => {
      f.budget.programs = [a.program]; f.budget.cap = cap.per_site; f.budget.cap_assumed = false; f.budget.room = cap.per_site - f.budget.total;
      return f;
    });
    const req = facilities.reduce((n, f) => n + f.budget.total, 0);
    return { application: a.id, label: a.label, program: a.program, cycle: a.cycle, status: a.status, sites: a.sites, facilities,
      prioritized: facilities.reduce((n, f) => n + f.prioritized, 0),
      budget: { requested: req, cap: cap.cap, room: cap.cap - req, cap_unknown: cap.cap_unknown } };
  }) : null;
  if (wish_lists) {
    const counted = wish_lists.filter(w => CAP_STATUSES.has(w.status));
    requested = counted.reduce((n, w) => n + w.budget.requested, 0);
    const cap = counted.reduce((n, w) => n + w.budget.cap, 0);
    budget = { requested, cap, room: cap - requested, sites: active.length, applications: counted.length };
  }
  const perApp = new Set(PER_APPLICATION_STEMS);
  const task = (stem, prefix, application, label) => ({
    stem, label: checklistLabel(stem), application, application_label: label,
    status: val(`${prefix}status_${stem}`) || 'Not started',
    due: val(`${prefix}due_${stem}`), owner: val(`${prefix}who_${stem}`), note: val(`${prefix}note_${stem}`),
    // side: who does it (client tasks are the client's to mark on the form; npsa tasks are the team's).
    // prefix: where its keys live (chk_ or chk_<application>_), for the team's checklist editor.
    side: CHECKLIST_META[stem]?.owner || 'client', title: CHECKLIST_META[stem]?.title || checklistLabel(stem), prefix,
  });
  const liveApps = stored ? applications.filter(a => a.status !== 'withdrawn') : [];
  const items = liveApps.length
    ? [
      ...CHECKLIST_STEMS.filter(stem => !perApp.has(stem)).map(stem => task(stem, 'chk_', null, null)),
      ...liveApps.flatMap(a => PER_APPLICATION_STEMS.map(stem => task(stem, checklistPrefix(a.id), a.id, a.label))),
    ]
    : CHECKLIST_STEMS.map(stem => task(stem, 'chk_', null, null));
  return {
    slug: client.slug, name: client.name, state: client.state, phase: client.phase, status: client.status,
    intake_url: intakeUrl(base, client.slug, client.token),
    submitted_at: client.submitted_at, last_client_activity_at: client.last_client_activity_at,
    filled_by: val('_filled_by'), status_line: val('_status'),
    applications, applications_set: stored,
    core: progress.core, sections, wish_list, ...(wish_lists ? { wish_lists } : {}), budget,
    programs: { listed: PROGRAM_SLOTS.filter(n => val(`prog${n}_name`) !== '').length, slots: PROGRAM_SLOTS.length },
    checklist: {
      completed: items.filter(t => t.status === 'Completed').length,
      not_applicable: items.filter(t => t.status === 'Not applicable').length,
      total: items.filter(t => t.status !== 'Not applicable').length,
      per_application: liveApps.length ? PER_APPLICATION_STEMS.length : 0,
      items,
    },
    uploads: uploads.map(u => uploadView(u, client.slug, documentsFor(client))),
    documents_received: receivedFor(client),
  };
}

// What the client page shows on its Contacts tab: the NPSA people first, then the
// client's own people. added_by tells the page which rows the client may remove.
function contactsView(contacts) {
  const pub = c => ({ name: c.name, role: c.role, email: c.email, phone: c.phone || '', added_by: c.added_by || '' });
  return {
    npsa: contacts.filter(c => c.side === 'npsa').map(pub),
    client: contacts.filter(c => c.side !== 'npsa' && c.side !== 'reference').map(pub),
    reference: contacts.filter(c => c.side === 'reference').map(pub),
  };
}

function clientView(client, base) {
  const { token, documents, applications, ...rest } = client;
  return {
    ...rest, intake_url: intakeUrl(base, client.slug, token), saa: knowledgeFor(client.state).saa || null,
    documents: documentsFor(client), documents_customised: Array.isArray(documents), documents_received: receivedFor(client),
    applications: Array.isArray(applications) ? applicationsFor(client) : [], applications_set: Array.isArray(applications),
    programs: programsFor(client.state),
  };
}

// ── Stores ────────────────────────────────────────────────────────────────────

const CLIENT_FIELDS = ['name', 'state', 'phase', 'status', 'program_track', 'drive_folder_id', 'upload_folder_id', 'asana_project_gid', 'kickoff_date', 'notes', 'documents', 'applications', 'documents_received'];

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
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS documents JSONB;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS applications JSONB;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS documents_received JSONB;
    ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ;
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
  asana_project_gid, to_char(kickoff_date, 'YYYY-MM-DD') AS kickoff_date, notes, documents, applications, documents_received, created_at, updated_at,
  submitted_at, last_client_activity_at`;

/** Postgres-backed store. Every method takes and returns plain objects. */
export function createIntakeStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const contactsFor = async id => (await pool.query(
    `SELECT id, name, email, role, phone, side, is_primary, added_by, welcomed_at, created_at FROM client_contacts WHERE client_id=$1
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
      const params = [slug, ...fields.map(k => ((k === 'documents' || k === 'applications' || k === 'documents_received') && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))];
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
    async markWelcomed(clientId, email) {
      await pool.query('UPDATE client_contacts SET welcomed_at=NOW() WHERE client_id=$1 AND email=$2', [clientId, email]);
    },
    async countsFor(clientId) {
      const q = async (sql) => Number((await pool.query(sql, [clientId])).rows[0].n);
      return {
        answers: await q('SELECT COUNT(*)::int AS n FROM intake_answers WHERE client_id=$1'),
        uploads: await q('SELECT COUNT(*)::int AS n FROM intake_uploads WHERE client_id=$1'),
        contacts: await q('SELECT COUNT(*)::int AS n FROM client_contacts WHERE client_id=$1'),
      };
    },
    async deleteClient(slug) {
      await pool.query('DELETE FROM clients WHERE slug=$1', [slug]); // contacts, answers and uploads cascade
    },
    async updateContact(clientId, email, patch) {
      const { rows } = await pool.query(
        `UPDATE client_contacts SET name=$3, role=$4, phone=$5, email=$6 WHERE client_id=$1 AND email=$2 RETURNING id`,
        [clientId, email, patch.name, patch.role, patch.phone, patch.email]);
      return rows.length > 0;
    },
    async getAnswers(clientId) {
      const { rows } = await pool.query('SELECT key, value, updated_at, updated_by FROM intake_answers WHERE client_id=$1', [clientId]);
      return new Map(rows.map(r => [r.key, r]));
    },
    async answerStats(clientIds) {
      if (!clientIds.length) return {};
      const { rows } = await pool.query(
        `SELECT client_id,
                ARRAY_AGG(key) FILTER (WHERE value <> '' AND key ~ $2) AS answered_keys,
                COUNT(*) FILTER (WHERE key ~ '^chk_(a[0-9]{1,2}_)?status_' AND value = 'Completed')::int AS checklist_completed,
                COUNT(*) FILTER (WHERE key ~ '^chk_(a[0-9]{1,2}_)?status_' AND value = 'Not applicable')::int AS checklist_na,
                MAX(value) FILTER (WHERE key = '_filled_by') AS filled_by
           FROM intake_answers WHERE client_id = ANY($1) GROUP BY client_id`, [clientIds, PROGRESS_KEY_RE.source]);
      const up = await pool.query('SELECT client_id, ARRAY_AGG(DISTINCT key) AS keys FROM intake_uploads WHERE client_id = ANY($1) GROUP BY client_id', [clientIds]);
      const uploaded = Object.fromEntries(up.rows.map(r => [r.client_id, r.keys]));
      return Object.fromEntries(rows.map(r => [r.client_id, { ...r, answered_keys: r.answered_keys || [], uploaded_keys: uploaded[r.client_id] || [] }]));
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
      const row = { id: nextId++, documents: null, applications: null, documents_received: null, ...c, created_at: now(), updated_at: now(), submitted_at: null, last_client_activity_at: null };
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
    async markWelcomed(clientId, email) {
      const c = contacts.find(x => x.client_id === clientId && x.email === email); if (c) c.welcomed_at = now();
    },
    async countsFor(clientId) {
      return { answers: (answers.get(clientId) || new Map()).size, uploads: uploads.filter(u => u.client_id === clientId).length, contacts: contacts.filter(c => c.client_id === clientId).length };
    },
    async deleteClient(slug) {
      const c = find(slug); if (!c) return;
      for (let i = contacts.length - 1; i >= 0; i--) if (contacts[i].client_id === c.id) contacts.splice(i, 1);
      for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].client_id === c.id) uploads.splice(i, 1);
      answers.delete(c.id);
      clients.splice(clients.indexOf(c), 1);
    },
    async updateContact(clientId, email, patch) {
      const cur = contacts.find(c => c.client_id === clientId && c.email === email); if (!cur) return false;
      Object.assign(cur, { name: patch.name, role: patch.role, phone: patch.phone, email: patch.email }); return true;
    },
    async getAnswers(clientId) { return new Map(bucket(clientId)); },
    async answerStats(ids) {
      return Object.fromEntries(ids.map(id => {
        const s = summarise(bucket(id), (clients.find(c => c.id === id)?.applications || []).filter(a => a.status !== 'withdrawn').length);
        return [id, { answered_keys: [...answeredSet(bucket(id))], uploaded_keys: [...new Set(uploads.filter(u => u.client_id === id).map(u => u.key))], checklist_completed: s.checklist.completed, checklist_na: s.checklist.not_applicable, filled_by: bucket(id).get('_filled_by')?.value || null }];
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
      req.actor = cleanActor(req.get('x-actor')) || 'internal';
      req.actorKind = 'mcp';
      return next();
    }
    const keys = splitKeys(process.env.MCP_API_KEYS || process.env.MCP_API_KEY);
    const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (keys.length && presented && keyMatches(presented, keys)) {
      // Only a key on ACTOR_PROXY_KEYS (the toolbox's, which has checked the
      // person's login) may name someone else; every other key is named for itself.
      const asserted = mayAssertActor(presented) ? cleanActor(req.get('x-actor')) : '';
      req.actor = asserted || nameFor(presented);
      req.actorKind = asserted ? 'user' : 'key';
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

export function renderClientPage({ client, stateConfig, existing, contacts = { npsa: [], client: [], reference: [] }, documents = documentsFor(client), applications = Array.isArray(client.applications) ? applicationsFor(client) : [], uploaded = [], received = Object.keys(receivedFor(client)), apiBase = '', uploadBase = '' }) {
  if (pageTemplate === undefined) {
    try { pageTemplate = readFileSync(TEMPLATE_URL, 'utf8'); } catch { pageTemplate = null; }
  }
  if (!pageTemplate) return null;
  const vars = { client: client.slug, token: client.token, clientName: client.name, state: client.state, stateConfig, existing, contacts, documents, applications, uploaded, received, apiBase, uploadBase, checklistMeta: CHECKLIST_META };
  return pageTemplate.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? jsForInject(vars[k]) : m));
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerIntake(app, { store, internalKey, publicBase, renderPage = renderClientPage, apiBase = '', uploadBase = '', drive, mail } = {}) {
  // Drive mirror: injectable for tests, otherwise on only when the key is set.
  if (drive === undefined) drive = driveConfigured() ? { upload: uploadToDrive } : null;
  // Welcome email: same shape, and off until a Workspace sender is configured.
  if (mail === undefined) mail = mailConfigured() ? { send: sendWelcome } : null;

  /**
   * The note a new contact gets, the way a shared Drive file tells someone they have access:
   * who added them, and the link. Best-effort — a mail failure never fails the request that
   * added the person, and NPSA and reference rows are never written to.
   */
  const welcome = async (client, email, { addedBy = '', force = false, req } = {}) => {
    if (!mail) return { sent: false, reason: 'welcome email is not configured' };
    const fresh = await store.getClient(client.slug);
    const contact = (fresh.contacts || []).find(c => c.email === email);
    if (!contact || contact.side !== 'client') return { sent: false, reason: 'not a client contact' };
    if (contact.welcomed_at && !force) return { sent: false, reason: 'already welcomed' };
    const sender = senderFor(fresh.contacts || []);
    try {
      const out = await mail.send({ client: fresh, contact, addedBy, sender, intakeUrl: intakeUrl(base(req), fresh.slug, fresh.token) });
      await store.markWelcomed(fresh.id, email);
      console.log(`[intake] welcome email ${fresh.slug} → ${email} as ${sender?.email || '?'}`);
      return { sent: true, ...out };
    } catch (err) {
      console.warn(`[intake] welcome email failed for ${fresh.slug}/${email}: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  };
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
        core: progressFor(r, new Set(s.answered_keys || []), new Set(s.uploaded_keys || [])).core,
        checklist: { completed: s.checklist_completed || 0, total: checklistTotal(r) - (s.checklist_na || 0), not_applicable: s.checklist_na || 0 },
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
    const applications = validApplications(b.applications, state);
    // The NPSA side of the Contacts tab: the standing team from intake-team.json,
    // plus whoever is named (the consultant who brought the client in, usually). Pass npsa_contacts: [] to
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
    // The SAA and program contacts from the knowledge base, unless the caller passes
    // reference_contacts: false (or names its own, which then replace them).
    const reference = b.reference_contacts === false ? []
      : b.reference_contacts !== undefined ? validContacts(b.reference_contacts, 'reference_contacts').map(c => ({ ...c, side: 'reference' }))
      : referenceContactsFor(state, (applications || []).map(a => a.program)).flatMap(c => { try { return [validContact(c, 'reference')]; } catch { return []; } }); // a malformed address in the base is skipped, not a failed create
    const taken = new Set([...contacts, ...npsa].map(c => c.email));
    const refs = reference.filter(c => !taken.has(c.email));
    if (refs.length) await store.addContacts(row.id, refs, `npsa:${req.actor}`);
    if (applications) await store.updateClient(slug, { applications });
    console.log(`[intake] client_create ${slug} by ${req.actor}`);
    res.status(201).json(clientView(await store.getClient(slug), base(req)));
  }));

  app.get('/api/clients/:slug', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const answers = await store.getAnswers(c.id);
    const uploaded = new Set((await store.listUploads(c.id)).map(u => u.key));
    res.json({ ...clientView(c, base(req)), ...summarise(answers), core: progressFor(c, answeredSet(answers), uploaded).core, filled_by: answers.get('_filled_by')?.value || '', status_line: answers.get('_status')?.value || '' });
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
    // Documents: replace the list, reset it (null), or add/remove against the current one.
    if (b.applications !== undefined) patch.applications = validApplications(b.applications, patch.state || c.state);
    if (b.documents !== undefined) patch.documents = validDocuments(b.documents, 'documents');
    if (b.add_documents !== undefined || b.remove_document_keys !== undefined) {
      const adds = validDocuments(b.add_documents, 'add_documents') || [];
      const removes = b.remove_document_keys === undefined ? [] : (Array.isArray(asArray(b.remove_document_keys)) ? asArray(b.remove_document_keys).map(k => String(k).toLowerCase()) : (() => { throw new BadRequest('remove_document_keys must be an array'); })());
      const current = patch.documents === undefined ? documentsFor(c) : (patch.documents || documentsFor({ ...c, documents: null }));
      const list = current.filter(d => !removes.includes(d.key) && !adds.some(a => a.key === d.key)).concat(adds.map(a => ({ ...a, source: 'custom' })));
      patch.documents = list;
    }
    const add = [
      ...validContacts(b.add_contacts),
      ...validContacts(b.add_npsa_contacts, 'add_npsa_contacts').map(x => ({ ...x, side: 'npsa' })),
      ...validContacts(b.add_reference_contacts, 'add_reference_contacts').map(x => ({ ...x, side: 'reference' })),
    ];
    const remove = validEmails(b.remove_contact_emails, 'remove_contact_emails');
    const invite = b.invite_contact_email === undefined ? '' : String(b.invite_contact_email).trim().toLowerCase();
    // Marking a document received (by email, in person) or taking the mark back.
    if (b.mark_documents_received !== undefined || b.unmark_documents_received !== undefined) {
      const docs = patch.documents === undefined ? documentsFor(c) : (patch.documents || documentsFor({ ...c, documents: null }));
      const marks = asArray(b.mark_documents_received) ?? [];
      const unmarks = asArray(b.unmark_documents_received) ?? [];
      if (!Array.isArray(marks) || !Array.isArray(unmarks)) throw new BadRequest('mark_documents_received and unmark_documents_received must be arrays');
      const next = { ...receivedFor(c) };
      for (const m of marks) {
        const key = String(typeof m === 'object' && m ? m.key : m || '').trim().toLowerCase();
        if (!docs.some(d => d.key === key)) throw new BadRequest(`"${key}" is not one of this client's documents`);
        next[key] = { at: new Date().toISOString(), by: req.actor || 'npsa', note: String((typeof m === 'object' && m && m.note) || 'received by email').slice(0, 140) };
      }
      for (const u of unmarks) delete next[String(u || '').trim().toLowerCase()];
      patch.documents_received = next;
    }
    // NPSA's notes on the client's answers, and which of them are questions the client should answer.
    // Both used to be typed into the form itself; the form now only shows them.
    const noteRows = [];
    if (b.question_notes !== undefined) {
      const n = b.question_notes;
      if (!n || typeof n !== 'object' || Array.isArray(n)) throw new BadRequest('question_notes must be an object of question key → note text');
      for (const [k, v] of Object.entries(n)) {
        const key = k.startsWith('note_') ? k : `note_${k}`;
        if (!QUESTION_BY_KEY.has(key)) throw new BadRequest(`"${k}" is not a question NPSA can leave a note on`);
        noteRows.push({ key, value: v === null || v === undefined ? '' : String(v).slice(0, MAX_VALUE) });
      }
    }
    if (b.note_asks !== undefined) {
      const list = asArray(b.note_asks);
      if (!Array.isArray(list)) throw new BadRequest('note_asks must be an array of question keys');
      const keys = [...new Set(list.map(k => String(k).trim().replace(/^note_/, '')).filter(Boolean))];
      const bad = keys.filter(k => !QUESTION_BY_KEY.has(`note_${k}`));
      if (bad.length) throw new BadRequest(`note_asks: not questions NPSA can ask about: ${bad.join(', ')}`);
      noteRows.push({ key: '_note_asks', value: keys.join(',') });
    }
    // The checklist, from the Grant Writing page: { "chk_status_kickoff_call": "Completed", "chk_a2_due_submit_application": "11/20/2026", … }.
    if (b.checklist !== undefined) {
      const ck = b.checklist;
      if (!ck || typeof ck !== 'object' || Array.isArray(ck)) throw new BadRequest('checklist must be an object of checklist key → value');
      for (const [key, v] of Object.entries(ck)) {
        const m = /^chk_(?:a(?:[2-9]|[1-9]\d)_)?(status|due|who|note)_(.+)$/.exec(key);
        if (!m || !CHECKLIST_STEM_SET.has(m[2])) throw new BadRequest(`"${key}" is not a checklist key`);
        const value = v === null || v === undefined ? '' : String(v).trim().slice(0, m[1] === 'note' ? 2000 : 120);
        if (m[1] === 'status' && value && !CHECKLIST_STATUSES.includes(value)) throw new BadRequest(`${key}: status must be one of ${CHECKLIST_STATUSES.join(', ')}`);
        noteRows.push({ key, value });
      }
    }
    if (!Object.keys(patch).length && !add.length && !remove.length && !invite && !noteRows.length) throw new BadRequest('Nothing to change');
    if (noteRows.length) await store.upsertAnswers(c.id, noteRows, `npsa:${req.actor}`);
    if (Object.keys(patch).length) await store.updateClient(c.slug, patch);
    if (remove.length) await store.removeContacts(c.id, remove);
    if (add.length) await store.addContacts(c.id, add, `npsa:${req.actor}`);
    // An invite is the team saying "send it now", so it goes even to someone welcomed before.
    const invited = invite ? await welcome(c, invite, { addedBy: '', force: true, req }) : null;
    console.log(`[intake] client_update ${c.slug} by ${req.actor} ${JSON.stringify(Object.keys(b))}`);
    const view = clientView(await store.getClient(c.slug), base(req));
    res.json(invited ? { ...view, invite: invited } : view);
  }));

  /**
   * Deletes a client and everything under it. Two steps on purpose: the first call
   * answers with what would be lost and writes nothing, and only a second call
   * naming the slug in `confirm` commits. An active client has to be cancelled or
   * closed first, so a live engagement cannot go by accident.
   */
  app.delete('/api/clients/:slug', team, guard(async (req, res) => {
    const c = await loadClient(req, res); if (!c) return;
    const confirm = String(req.query.confirm || (req.body || {}).confirm || '');
    const counts = await store.countsFor(c.id);
    const summary = { slug: c.slug, name: c.name, status: c.status, ...counts };
    if (c.status === 'active') throw new BadRequest(`${c.name} is an active client. Set status to cancelled or closed before deleting it.`, { client: summary });
    if (confirm !== c.slug) {
      return res.status(400).json({
        error: `Nothing was deleted. This would permanently remove ${c.name} with ${counts.answers} answer(s), ${counts.uploads} upload(s) and ${counts.contacts} contact(s). Call again with confirm="${c.slug}" to go ahead.`,
        confirm_required: c.slug, client: summary,
      });
    }
    await store.deleteClient(c.slug);
    console.log(`[intake] client_delete ${c.slug} by ${req.actor} (${counts.answers} answers, ${counts.uploads} uploads)`);
    res.json({ ok: true, deleted: summary });
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
    // Wish lists for a client's second and later applications live under wl_<id>_f<n>_ keys; they are
    // listed after the catalog, grouped by application, and only where something is stored.
    const apps = applicationsFor(c);
    const extra = [...answers.keys()].filter(k => WL_APP_KEY_RE.test(k) || CHK_APP_KEY_RE.test(k)).map(k => {
      const id = (WL_APP_KEY_RE.exec(k) || CHK_APP_KEY_RE.exec(k))[1], q = QUESTION_BY_KEY.get(catalogKey(k)), app = apps.find(a => a.id === id);
      if (!q) return { q: null };
      const who = app ? app.label : id;
      return { key: k, id, q, section: q.section.replace(/^(Wish List|Checklist)/, `$1 (${who})`), label: `${who} · ${q.label}` };
    }).filter(x => x.q).sort((x, y) => (x.id === y.id ? x.q.ordinal - y.q.ordinal : x.id.localeCompare(y.id, 'en', { numeric: true })));
    const extras = q => ({ ...(q.number ? { number: q.number } : {}), ...(q.prompt ? { prompt: q.prompt } : {}) });
    const rows = [...QUESTIONS.map(q => ({ key: q.key, section: q.section, label: q.label, kind: q.kind, ...extras(q) })), ...extra.map(x => ({ key: x.key, section: x.section, label: x.label, kind: x.q.kind }))]
      .filter(q => !section || q.section.toLowerCase() === section)
      .map(q => { const a = answers.get(q.key); return { ...q, value: a?.value || '', updated_at: a?.updated_at || null, updated_by: a?.updated_by || '' }; })
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
    // 1.1 Primary contact starts from the client's primary contact, the first time the form opens with it blank.
    const primary = (c.contacts || []).filter(x => x.side !== 'npsa' && x.side !== 'reference').sort((a, b) => (b.is_primary === true) - (a.is_primary === true))[0];
    if (primary && PRIMARY_CONTACT_KEYS.every(k => !answers.get(k)?.value)) {
      const rows = PRIMARY_CONTACT_KEYS.map((key, i) => ({ key, value: String([primary.name, primary.role, primary.email, primary.phone][i] || '') })).filter(r => r.value);
      if (rows.length) { await store.upsertAnswers(c.id, rows, 'contacts'); rows.forEach(r => answers.set(r.key, { key: r.key, value: r.value })); }
    }
    const uploads = await store.listUploads(c.id);
    const html = renderPage && renderPage({
      client: c, stateConfig: stateConfig(c.state, (Array.isArray(c.applications) ? c.applications : []).filter(a => a.status !== 'withdrawn').map(a => a.program)), apiBase, uploadBase, contacts: contactsView(c.contacts || []),
      documents: documentsFor(c), uploaded: [...new Set(uploads.map(u => u.key))],
      existing: Object.fromEntries([...answers.values()].filter(a => a.value !== '').map(a => [a.key, a.value])),
    });
    if (!html) return res.status(503).type('html').send(errorPage('The intake form has not been deployed here yet.'));
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });

  app.put('/api/intake/:slug/answers', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    // NPSA's notes are the team's to write (Grant Writing page, intake_seed); a page that still
    // sends them, from before the form showed them read-only, has them dropped rather than refused.
    // NPSA's checklist tasks are the team's to update too (Grant Writing page); the form shows them read-only.
    const rows = normaliseAnswers((req.body || {}).answers).filter(r => !r.key.startsWith('note_') && !npsaChecklistKey(r.key));
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
  app.options('/api/intake/:slug/upload', uploadCors);
  app.post('/api/intake/:slug/upload', uploadCors, rawUploadBody(), uploadBodyError, guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const form = await readMultipart(req);
    if (!form) throw new BadRequest('Send the file as multipart form data with fields "key" and "file".');
    const key = String(form.get('key') || '');
    const file = form.get('file');
    const q = QUESTION_BY_KEY.get(key);
    const isCatalogUpload = q && q.kind === 'upload';
    if (!isCatalogUpload && !documentsFor(c).some(d => d.key === key)) throw new BadRequest(`"${key}" is not one of this client's documents`);
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
    if (isCatalogUpload) await store.upsertAnswers(c.id, [{ key, value: note }], by, { clientActivity: true });
    else await store.upsertAnswers(c.id, [], by, { clientActivity: true }).catch(() => {});
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
    const mailed = await welcome(c, contact.email, { addedBy: who, req });
    res.json({ ok: true, welcomed: mailed.sent, ...contactsView(fresh.contacts || []) });
  }));

  // The client can correct their own people (a phone number added later, a
  // role change). NPSA and reference rows stay with NPSA.
  app.put('/api/intake/:slug/contacts', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const row = (c.contacts || []).find(x => x.email === email);
    if (!row) return res.status(404).json({ error: 'No such contact' });
    if (row.side !== 'client') throw new BadRequest('That contact is managed by NPSA.');
    let next;
    try { next = validContact({ name: b.name, email: b.new_email || email, role: b.role, phone: b.phone }, 'contact'); }
    catch { throw new BadRequest('Please give a valid email address.'); }
    if (!next.name) throw new BadRequest('Please give the person\'s name.');
    if (next.email !== email && (c.contacts || []).some(x => x.email === next.email)) throw new BadRequest('Someone with that email is already listed.');
    await store.updateContact(c.id, email, next);
    await store.upsertAnswers(c.id, [], 'client', { clientActivity: true }).catch(() => {});
    const fresh = await store.getClient(c.slug);
    console.log(`[intake] contact edited ${c.slug} ${email}`);
    res.json({ ok: true, ...contactsView(fresh.contacts || []) });
  }));

  app.delete('/api/intake/:slug/contacts', guard(async (req, res) => {
    const c = await clientAuth(req, res); if (!c) return;
    const email = String(req.query.email || (req.body || {}).email || '').trim().toLowerCase();
    const row = (c.contacts || []).find(x => x.email === email);
    if (!row) return res.status(404).json({ error: 'No such contact' });
    if (row.side !== 'client') throw new BadRequest('That contact is managed by NPSA.');
    await store.removeContacts(c.id, [email]);
    const fresh = await store.getClient(c.slug);
    console.log(`[intake] contact removed ${c.slug} ${email}`);
    res.json({ ok: true, ...contactsView(fresh.contacts || []) });
  }));

}
