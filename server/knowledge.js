/**
 * What the client intake pages take from the grant knowledge base: a state's SAA,
 * its registration steps, the upload rows a client is asked for, program caps, and
 * the reference contacts a new client starts with.
 *
 * All of it reaches clients, so only verified records count. A verified record
 * whose field was changed and not yet confirmed keeps its other fields, and that
 * one is left out as if unknown (a cap nobody has confirmed shows as "not
 * published" rather than as a guess). A record under an unverified parent drops
 * with it.
 *
 * The pre-call briefing reads the same snapshot for a state's SAA and its state-funded
 * programs (briefingFor), so a rep and a client see the same facts.
 *
 * Both build synchronously, so this keeps a snapshot in memory: loaded at boot,
 * refreshed every minute and after each knowledge write. Until the first one arrives
 * (or if the database has no knowledge rows) the seed bundle the knowledge base was
 * loaded from answers instead, so a cold start never shows an empty page.
 */
import { readFileSync } from 'fs';
import { activeTree, assemble, federalBaseline } from './grant-knowledge.js';

// ── Records → projection ──────────────────────────────────────────────────────

/** Verified records only, each without the fields a person has not confirmed since they changed. */
export function trustedRecords(records) {
  const verified = records.filter(r => r.status === 'verified' && !r.archived_at);
  const kept = activeTree(verified); // a record whose parent is not verified is not in `verified`, so it drops here
  return kept.map(r => {
    const flagged = r.unverified_fields || [];
    if (!flagged.length) return r;
    const data = { ...r.data };
    for (const f of flagged) delete data[f];
    return { ...r, data };
  });
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** One upload row in the shape intake-documents.json used: key, label, hint, ready, task. */
function uploadRow(req, base = null) {
  const d = req.data, b = base?.data || {};
  const key = d.upload_key || b.upload_key;
  if (!key) return null;
  return clean({
    key,
    label: d.client_label || b.client_label || d.label || b.label,
    hint: d.client_hint ?? b.client_hint,
    ready: d.ready_label || b.ready_label,
    task: d.task_stem || b.task_stem,
  });
}

// What a program has from the state: its own requirements and a sibling's it inherits (NSGP-UA from NSGP-S).
const stateSide = program => [...program.inherited_requirements.filter(r => r.inherited_from), ...program.requirements];

/**
 * A federal program's upload rows: the US baseline in its order, each one in the
 * state's own wording where the state has the same requirement, then what the
 * state adds. `source` says which (the Documents tab shows it).
 */
function federalUploads(program, baseline) {
  const mine = stateSide(program);
  const own = new Map(mine.map(r => [r.key, r]));
  const rows = [];
  for (const b of baseline) {
    const row = uploadRow(own.get(b.key) || b, own.has(b.key) ? b : null);
    if (row) rows.push({ ...row, source: 'standard' });
  }
  const baseKeys = new Set(baseline.map(b => b.key));
  for (const r of mine) {
    if (baseKeys.has(r.key) || r.data.req_type !== 'document') continue;
    const row = uploadRow(r);
    if (row && !rows.some(x => x.key === row.key)) rows.push({ ...row, source: 'state' });
  }
  return rows;
}

function registrationSteps(program, baseline, guides = baseline) {
  const mine = stateSide(program);
  const own = new Set(mine.map(r => r.key));
  const all = [...baseline.filter(b => !own.has(b.key)), ...mine].filter(r => r.data.req_type === 'registration');
  const seen = new Set();
  return all
    .filter(r => (seen.has(r.key) ? false : seen.add(r.key)))
    .sort((a, b) => Number(Boolean(b.data.hard_gate)) - Number(Boolean(a.data.hard_gate)) || (b.data.lead_time_days || 0) - (a.data.lead_time_days || 0))
    .map(r => {
      // A state's own copy of a baseline step (its SAM.gov line, a state program's too) keeps the federal guide unless it writes its own.
      const d = r.data, b = guides.find(x => x.key === r.key && x !== r)?.data || {};
      return clean({
        key: r.key, label: d.client_label || b.client_label || d.label, hard_gate: Boolean(d.hard_gate), note: d.client_hint ?? b.client_hint,
        owner: d.owner, url: d.url || b.url, lead_time_days: d.lead_time_days ?? b.lead_time_days,
        // The "How to do this" box on the client's checklist: what to have ready, then the steps.
        ready: d.client_ready ?? b.client_ready, steps: d.client_steps ?? b.client_steps,
      });
    });
}

function contactRow(c, program, saa) {
  const d = c.data;
  if (!d.email || d.warning) return null;
  // A shared inbox often has no person's name; the office's name reads better than a bare address.
  const name = d.name || d.org || [saa, { saa: 'grants', program: 'program office', cisa_psa: 'CISA' }[d.contact_kind]].filter(Boolean).join(' ');
  const role = [d.role, d.name && d.org ? d.org : '', program ? program : ''].filter(Boolean).join(', ') || { saa: 'State administering agency', cisa_psa: 'CISA Protective Security Advisor' }[d.contact_kind] || '';
  return clean({ name, role, email: d.email, phone: d.phone, kind: d.contact_kind, primary: Boolean(d.is_primary), program });
}

/** One state's projection. */
export function projectState(doc, baseline, usProgram) {
  const j = doc.jurisdiction?.data || {};
  const live = p => !['dead'].includes(p.data.status);
  const federal = doc.programs.filter(p => p.data.type === 'federal' && live(p));
  const nsgpS = federal.find(p => p.key === 'NSGP-S') || federal[0] || null;
  const state = doc.programs.filter(p => p.data.type === 'state' && live(p));

  // A state whose federal program nobody has verified still gets the US baseline, under `baseline`.
  const bare = { requirements: [], inherited_requirements: [] };
  const registration = { baseline: registrationSteps(bare, baseline) };
  const documents = { baseline: federalUploads(bare, baseline) };
  for (const p of [...federal, ...state]) {
    registration[p.key] = p.data.type === 'federal' ? registrationSteps(p, baseline) : registrationSteps(p, [], baseline);
    const rows = p.data.type === 'federal' ? federalUploads(p, baseline) : p.requirements.map(r => uploadRow(r)).filter(Boolean).map(r => ({ ...r, source: 'program' }));
    if (rows.length) documents[p.key] = rows;
  }

  const contacts = [
    ...doc.contacts.map(c => contactRow(c, null, j.saa_short)),
    ...doc.programs.filter(live).flatMap(p => p.contacts.map(c => contactRow(c, p.key, j.saa_short))),
  ].filter(Boolean);

  return {
    saa: j.saa || '',
    saaShort: j.saa_short || '',
    federal: {
      perSite: nsgpS?.data.cap_per_location ?? usProgram?.data.cap_per_location ?? null,
      locationsMax: nsgpS?.data.locations_max ?? usProgram?.data.locations_max ?? null,
      programs: federal.map(p => ({ code: p.key, name: p.data.name })),
    },
    programs: state.map(p => ({
      code: p.key, name: p.data.name, status: p.data.status || 'active',
      per_site: p.data.cap_per_location ?? null, per_applicant: p.data.cap_per_applicant ?? null,
      exclusive_with: Array.isArray(p.data.exclusive_with) ? p.data.exclusive_with : [],
      quotes_required: p.data.quotes_required === true,
      stackable: typeof p.data.stackable === 'boolean' ? p.data.stackable : null,
      note: p.data.notes_md || p.data.submission?.package_note || '',
      administered_by: p.data.administered_by || '',
      availability_note: p.data.availability_note || '',
    })),
    registration,
    documents,
    contacts,
  };
}

/** Every jurisdiction's projection from a full list of records. */
export function buildKnowledge(records, now = new Date()) {
  const trusted = trustedRecords(records);
  const baseline = federalBaseline(trusted, now);
  const usDoc = assemble('US', trusted, { now });
  const usProgram = usDoc.programs[0] || null;
  const codes = [...new Set(trusted.filter(r => r.kind === 'jurisdiction' && r.jurisdiction !== 'US').map(r => r.jurisdiction))];
  const states = {};
  for (const code of codes) states[code] = projectState(assemble(code, trusted, { now, federal: baseline }), baseline, usProgram);
  return { at: now.toISOString(), records: trusted.length, states };
}

// ── Reading it ────────────────────────────────────────────────────────────────

/**
 * What a "State Program" site can draw on when the Locations tab does not say
 * which state program: every live state program, except that of a set the state
 * awards only one of (exclusive_with, New Jersey's THE and SP), only the largest
 * counts. Dormant programs are left out: there is nothing to apply to.
 */
export function combinedStateProgram(programs) {
  const open = programs.filter(p => p.status !== 'dormant');
  if (!open.length) return null;
  const groups = [];
  for (const p of open) {
    const g = groups.find(g => g.some(x => x.exclusive_with.includes(p.code) || p.exclusive_with.includes(x.code)));
    if (g) g.push(p); else groups.push([p]);
  }
  const size = p => p.per_applicant ?? (p.per_site != null ? p.per_site * 3 : -1);
  const picks = groups.map(g => [...g].sort((a, b) => size(b) - size(a))[0]);
  const sum = key => (picks.every(p => p[key] != null) ? picks.reduce((n, p) => n + p[key], 0) : null);
  const acronym = groups.map(g => g.map(p => p.code).join(' or ')).join(' + ');
  const name = picks.length === 1 && groups[0].length === 1 ? picks[0].name : open.map(p => p.name).join('; ');
  const perSite = sum('per_site');
  // A per-applicant limit holds only if every counted program has one or a per-site cap to stand in.
  const perApplicant = picks.some(p => p.per_applicant != null) && picks.every(p => p.per_applicant != null || p.per_site != null)
    ? picks.reduce((n, p) => n + (p.per_applicant ?? p.per_site * 3), 0) : null;
  return { acronym, name, perSite, perApplicant, programs: picks.map(p => p.code) };
}

let snapshot = null;
let seed = null;

/**
 * The seed bundle (server/grant-knowledge-seed.json, what the knowledge base was first
 * loaded from) as store-shaped records. Its import keys become ids and parents.
 */
export function seedRecords() {
  const { records } = JSON.parse(readFileSync(new URL('./grant-knowledge-seed.json', import.meta.url), 'utf8'));
  const ids = new Map(records.map((r, i) => [r.import_key, i + 1]));
  return records.map((r, i) => ({
    id: i + 1, jurisdiction: r.jurisdiction, kind: r.kind, key: r.key, data: r.data,
    parent_id: r.parent ? ids.get(r.parent) ?? -1 : null, status: r.status || 'unverified', unverified_fields: [],
    sort_order: r.sort_order || 0, verified_at: r.verified_at || null, verified_by: r.verified_by || '', archived_at: null,
  }));
}
function seedSnapshot() { return (seed ||= buildKnowledge(seedRecords())); }

/** The live projection, or the seed's until the first load. */
export function knowledgeSnapshot() { return snapshot || seedSnapshot(); }
/** Whether the live knowledge base has loaded (false: the seed is answering). */
export function knowledgeLive() { return Boolean(snapshot); }
/** For tests and for the sync below. An empty projection counts as none. */
export function setKnowledgeSnapshot(s) { snapshot = s && Object.keys(s.states || {}).length ? s : null; }
/** One state's projection, or null for a code the knowledge base does not have. */
export function knowledgeFor(state) { return knowledgeSnapshot().states[String(state || '').toUpperCase()] || null; }

/**
 * What the pre-call briefing needs about a state: the SAA's full name, the federal
 * per-site cap, and the state-funded programs in the shape its funding block reads.
 * A program run by someone other than the SAA says so; the SAA running it does not.
 */
export function briefingFor(state) {
  const kb = knowledgeFor(state);
  if (!kb) return null;
  const isSaa = who => !who || [kb.saaShort, kb.saa].some(x => x && (x === who || x.includes(who) || who.includes(x)));
  return {
    saa: kb.saa || null,
    federalSiteCap: kb.federal.perSite || 200000,
    programs: kb.programs.map(p => ({
      acronym: p.code, name: p.name, perSite: p.per_site, perApplicant: p.per_applicant,
      stackable: p.stackable ?? 'verify', note: p.note,
      ...(p.exclusive_with.length ? { exclusiveWith: p.exclusive_with } : {}),
      ...(p.status === 'dormant' ? { dormant: true, availabilityNote: p.availability_note || 'no current round on record.' } : {}),
      ...(p.status === 'unconfirmed' ? { unconfirmed: true, availabilityNote: p.availability_note || 'not confirmed that it runs.' } : {}),
      ...(!isSaa(p.administered_by) ? { administeredBy: p.administered_by } : {}),
    })),
  };
}

/**
 * Keeps the snapshot current. `refresh()` is also what the knowledge routes call
 * after a write, so an edit shows on client pages at once rather than within the minute.
 */
export function startKnowledgeSync({ store, intervalMs = 60000, now = () => new Date(), log = console } = {}) {
  if (!store) return { refresh: async () => null, stop() {} };
  let running = null;
  const refresh = () => {
    if (running) return running;
    running = store.listRecords()
      .then(records => { setKnowledgeSnapshot(buildKnowledge(records, now())); return snapshot; })
      .catch(err => { log.error?.(`[knowledge] refresh failed, keeping the last snapshot: ${err.message}`); return snapshot; })
      .finally(() => { running = null; });
    return running;
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return { refresh, stop: () => clearInterval(timer) };
}
