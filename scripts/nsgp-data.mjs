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

const KB = JSON.parse(readFileSync(new URL('../server/nsgp-data.json', import.meta.url), 'utf8'));
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

const checks = {
  'all 50 states plus DC are present': Object.keys(states).length === 51,
  'every jurisdiction names an agency': !problems.some((p) => p.includes('administering agency')),
  'no malformed rows': problems.length === 0,
  'at least one confirmed deadline on record': confirmed.length > 0,
  'state programs recorded beyond the original three':
    new Set(Object.entries(states).filter(([, s]) => (s.state_programs || []).length).map(([k]) => k)).size > 3,
  'territories are declared as out of scope': Array.isArray(KB._not_covered) && KB._not_covered.length > 0,
  'provenance is documented': !!KB._source && !!KB._regenerate && !!KB._confidence,
};

for (const p of problems) console.log(`  ! ${p}`);
if (problems.length) console.log('');

let failed = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) failed++;
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
}

console.log(`\n${Object.keys(states).length} jurisdictions · ${dated.length} dated rows ` +
  `(${confirmed.length} confirmed) · ${programs.length} state-funded programs`);
console.log(`${Object.keys(checks).length - failed}/${Object.keys(checks).length} checks passed`);
process.exit(failed ? 1 : 0);
