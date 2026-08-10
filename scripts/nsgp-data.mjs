#!/usr/bin/env node
/*
 * Integrity check for server/nsgp-data.json.
 *
 * The file is an extraction of NPSA's grant-knowledge base (states/*.yaml in the
 * shared Drive folder) and it drives three things a rep sees: the administering
 * agency named in the briefing, the state-funded programs offered alongside
 * federal NSGP, and the deadline section. A malformed row here is not a crash —
 * it is a confidently-worded wrong answer on a sales call, which is the failure
 * mode this whole area of the tool has been fixed for twice already.
 *
 * So this asserts shape rather than content: every jurisdiction names an agency,
 * every dated row carries a source and a confidence, every cap is a number or an
 * explicit null, and stackability is never left to be guessed.
 *
 *   node scripts/nsgp-data.mjs
 */

import { readFileSync } from 'fs';
import { __test, SAA_BY_STATE, STATE_PROGRAMS_BY_STATE } from '../server/nsgp-deadlines.js';

const KB = JSON.parse(readFileSync(new URL('../server/nsgp-data.json', import.meta.url), 'utf8'));
const VERIFIED = JSON.parse(readFileSync(new URL('../server/nsgp-verified.json', import.meta.url), 'utf8'));
const states = KB.states;
const problems = [];
const note = (state, msg) => problems.push(`${state}: ${msg}`);

const ABBR = /^[A-Z]{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

for (const [st, s] of Object.entries(states)) {
  if (!ABBR.test(st)) note(st, 'key is not a 2-letter jurisdiction code');
  if (!s.saa || s.saa.length < 8) note(st, 'no administering agency recorded');
  if (!s.last_verified) note(st, 'no last_verified date');

  for (const d of s.deadlines || []) {
    if (!d.program) note(st, 'deadline row with no program');
    if (d.date && !ISO.test(d.date)) note(st, `deadline "${d.date}" is not YYYY-MM-DD`);
    if (d.date && !d.source) note(st, `deadline ${d.date} has no source`);
    if (d.date && !['confirmed', 'illustrative'].includes(d.confidence)) {
      note(st, `deadline ${d.date} has confidence "${d.confidence}" — must be confirmed or illustrative`);
    }
    if (d.date && d.cycle == null) note(st, `deadline ${d.date} has no cycle year`);
  }

  for (const p of s.state_programs || []) {
    if (!p.acronym || !p.name) note(st, 'state program missing acronym or name');
    for (const k of ['perSite', 'perApplicant']) {
      if (!(k in p)) note(st, `${p.acronym}: ${k} not stated (use null if unpublished)`);
      else if (p[k] !== null && !Number.isFinite(p[k])) note(st, `${p.acronym}: ${k} is not a number or null`);
    }
    // A program presented as stackable when it is not is a wrong pitch, so the
    // three states that bar federal awardees have to be explicit, not defaulted.
    if (![true, false, 'verify'].includes(p.stackable)) {
      note(st, `${p.acronym}: stackable must be true, false, or "verify"`);
    }
  }
}

const dated = Object.values(states).flatMap((s) => (s.deadlines || []).filter((d) => d.date));
const confirmed = dated.filter((d) => d.confidence === 'confirmed');
const programs = Object.values(states).flatMap((s) => s.state_programs || []);

/*
 * The web-check overlay.
 *
 * The extraction and the check are two layers on purpose, and the thing most likely
 * to go wrong is the seam between them: a correction that silently stops applying
 * because a key drifted would leave the ORIGINAL wrong date in place while every
 * surface reported the table as verified. Texas is the case in point, so it is
 * asserted by name rather than only in aggregate.
 */
const seed = __test.SEED;
const find = (state, program, cycle) =>
  seed.find((r) => r.state === state && r.program === program && r.cycleYear === cycle);

for (const c of VERIFIED.corrections) {
  const target = c.nowCycle ?? c.cycle;
  const row = find(c.state, c.program, target);
  if (!row) note(c.state, `correction for ${c.program} FY${target} matches no seeded row — key drift`);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(c.now) && row.deadline !== c.now) {
    note(c.state, `correction not applied: ${c.program} FY${target} is ${row.deadline}, expected ${c.now}`);
  }
}
for (const d of VERIFIED.downgrades) {
  const row = find(d.state, d.program, d.cycle);
  if (row && row.confidence !== d.to) note(d.state, `downgrade not applied: ${d.program} FY${d.cycle} still ${row.confidence}`);
}
for (const a of VERIFIED.additions) {
  if (!find(a.state, a.program, a.cycle)) note(a.state, `addition missing from seed: ${a.program} FY${a.cycle}`);
}

const tx = find('TX', 'federal', 2026);
const njPrograms = STATE_PROGRAMS_BY_STATE.NJ || [];

const checks = {
  'all 50 states plus DC are present': Object.keys(states).length === 51,
  'every jurisdiction names an agency': !problems.some((p) => p.includes('administering agency')),
  'no malformed rows': problems.length === 0,
  'at least one confirmed deadline on record': confirmed.length > 0,
  'state programs recorded beyond the original three':
    new Set(Object.entries(states).filter(([, s]) => (s.state_programs || []).length).map(([k]) => k)).size > 3,
  'territories are declared as out of scope': Array.isArray(KB._not_covered) && KB._not_covered.length > 0,
  'provenance is documented': !!KB._source && !!KB._regenerate && !!KB._confidence,

  // The overlay
  'the web check records its date, method and evidence limits':
    !!VERIFIED._checked && !!VERIFIED._method && !!VERIFIED._evidence_limit,
  'every correction, downgrade and addition still lands on a real row': problems.length === 0,
  'Texas reads February, not July': tx?.deadline === '2026-02-12',
  'the Texas row says it was corrected and what it was before': /Corrected .*was 2026-07-06/.test(tx?.note || ''),
  'a downgraded row is no longer presented as confirmed':
    find('SD', 'federal', 2026)?.confidence === 'illustrative',
  'rows carry the layer they came from': seed.every((r) => !!r.layer),
  'the two New Jersey programs are marked mutually exclusive':
    njPrograms.length === 2 && njPrograms.every((p) => p.exclusiveWith?.length === 1),
  'a program with no live cycle is flagged rather than quietly quoted':
    (STATE_PROGRAMS_BY_STATE.FL || []).every((p) => p.dormant === true),
  'every claim carries a source': [...VERIFIED.additions, ...VERIFIED.confirmed_unchanged]
    .every((x) => !!(x.source || x.sources?.length)),
};

for (const p of problems) console.log(`  ! ${p}`);
if (problems.length) console.log('');

let failed = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) failed++;
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
}

// Report what actually ships (extraction + overlay), not just the extraction — the
// two diverging without anyone noticing is the failure this file exists to catch.
const today = new Date().toISOString().slice(0, 10);
const open = seed.filter((r) => r.deadline >= today);
console.log(`\n${Object.keys(states).length} jurisdictions · ${dated.length} extracted dated rows ` +
  `(${confirmed.length} confirmed) · ${programs.length} state-funded programs`);
console.log(`shipping ${seed.length} rows after the ${VERIFIED._checked} check ` +
  `(+${VERIFIED.additions.length} added, ${VERIFIED.corrections.length} corrected, ${VERIFIED.downgrades.length} downgraded)`);
console.log(open.length
  ? `open as of ${today}: ${open.map((r) => `${r.state} ${r.program} ${r.deadline}`).join(' · ')}`
  : `nothing open as of ${today}`);
console.log(`${Object.keys(checks).length - failed}/${Object.keys(checks).length} checks passed`);
process.exit(failed ? 1 : 0);
