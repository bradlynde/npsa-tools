#!/usr/bin/env node
/*
 * Which locations count under which program.
 *
 * Stuart, on a California CSNSGP letter for one campus: "It's showing the max
 * grant as zero dollars. No matter what I change on the form" — and he was
 * right that the form offered no way out. The per-location program chips only
 * appear when an engagement runs more than one program, so a CSNSGP-only letter
 * had no control at all, while the location still carried the default
 * ["federal"] that thirteen copies of `l.programs || ["federal"]` read as the
 * answer. Every state-program letter therefore counted ZERO locations: $0 on the
 * page, and multi-site engagements priced as a single application.
 *
 * The rule is now one function. An unrecorded list means every program in the
 * engagement, a recorded one is intersected with the engagement so a program
 * dropped from the letter stops speaking for a location, and a deliberate
 * per-location choice still wins when there is more than one program to choose
 * between. This pins all four.
 *
 *   node scripts/award-scope.mjs
 */

import {
  totalMaxAward, applicationCount, locationPrograms, locationInProgram, PROGRAMS,
} from '../src/generator/engine.js';
import { defaultForm } from '../src/generator/defaults.js';

const fails = [];
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) fails.push(what);
};

const CA = [{ key: 'california', year: '2026' }];
const FED = [{ key: 'federal', year: '2026' }];
const BOTH = [{ key: 'federal', year: '2026' }, { key: 'california', year: '2026' }];
const site = (programs) => (programs ? { name: 'Main Campus', programs } : { name: 'Main Campus' });

// ── The reported bug, exactly: Trinity Cathedral, CSNSGP, one campus ──────────
eq(totalMaxAward(CA, [site(['federal'])]), 250000, 'a saved letter switched to CSNSGP still reports the CSNSGP cap');
eq(applicationCount(CA, [site(['federal'])]), 1, 'and counts its one campus as one application');

// ── A location that never recorded a choice belongs to whatever is running ────
eq(totalMaxAward(CA, [site(), site()]), 500000, 'two unrecorded sites both count under a CSNSGP-only letter');
eq(applicationCount(CA, [site(), site()]), 2, 'and price as two applications, not one');
eq(totalMaxAward([{ key: 'illinois' }], [site()]), 150000, 'NSGP-IL uses its own $150,000 cap');
eq(totalMaxAward([{ key: 'newyork' }], [site()]), 200000, 'NYSCAHC uses its own $200,000 cap');

// ── The federal case that always worked must not move ─────────────────────────
eq(totalMaxAward(FED, [site(['federal']), site(['federal'])]), 400000, 'federal letters are unchanged');
eq(applicationCount(FED, [site(['federal']), site(['federal'])]), 2, 'and still price per location');

// ── With a real choice to make, a deliberate one still wins ───────────────────
eq(totalMaxAward(BOTH, [site(['federal'])]), 200000, 'a site opted into federal only is not given the CSNSGP cap too');
eq(applicationCount(BOTH, [site(['federal'])]), 1, 'and is one application, not two');
eq(totalMaxAward(BOTH, [site(['federal', 'california'])]), 450000, 'a site in both programs sums both caps');
eq(applicationCount(BOTH, [site(['federal', 'california'])]), 2, 'and is two applications — priced as two');
eq(locationPrograms(site(['california']), BOTH), ['california'], 'a recorded choice is reported as recorded');
eq(locationPrograms(site(), BOTH), ['federal', 'california'], 'an unrecorded one covers the whole engagement');
eq(locationInProgram(site(['federal']), 'california', BOTH), false, 'and opting out of a program means out');

// ── The default form must not answer a question nobody asked ──────────────────
eq('programs' in defaultForm.locations[0], false, 'a new letter starts with no program written on its location');
eq(totalMaxAward(CA, defaultForm.locations), 250000, 'so picking CSNSGP first shows the CSNSGP cap straight away');

// ── Every program's cap is a real number, not a default ───────────────────────
for (const [key, cfg] of Object.entries(PROGRAMS)) {
  const cap = parseFloat(String(cfg.maxAward).replace(/,/g, ''));
  eq(totalMaxAward([{ key }], [site()]), cap, `${cfg.acronym} caps at ${cfg.maxAward} per site`);
}

if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
