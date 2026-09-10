#!/usr/bin/env node
/*
 * One letter per application, and the client pays the same.
 *
 * Brad, asked whether every multi-program engagement should be split: "No. We
 * only need Implementation contracts and all contingent contracts to be one
 * contract per app." Stuart asked that hitting the limit divide the work rather
 * than refuse it — "so that they don't have to go back and put in all of the
 * work again and have potential issues in the engagement letter" — and settled
 * the pricing: the split letters keep the combined total between them.
 *
 * That last part is the whole reason this file exists. The pricing table gives a
 * volume rate for two and three applications, so re-pricing each half at the
 * one-application rate would raise a live quote by thousands without anyone
 * choosing to: two contingent applications are $22,000 together and $28,000
 * apart. Every case here proves the halves still add up to the whole.
 *
 *   node scripts/split-letters.mjs
 */

import {
  calcFees, divideFee, enumerateApplications, oneApplicationPerLetter, programsKeyFor,
} from '../src/generator/engine.js';

const fails = [];
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) fails.push(what);
};

// ── Which documents the rule covers ──────────────────────────────────────────
eq(oneApplicationPerLetter('post', ''), true, 'Award Implementation is one application per letter');
eq(oneApplicationPerLetter('pre', 'partial-contingency'), true, 'so is a contingent pre-award letter');
eq(oneApplicationPerLetter('inh', 'inh-partial-contingency'), true, 'and a contingent in-house letter');
eq(oneApplicationPerLetter('pre', 'pre-only'), false, 'a flat Pre-Award Only letter is left alone');
eq(oneApplicationPerLetter('inh', 'inh-pre-only'), false, 'in-house flat too — Brad said only these two');
eq(programsKeyFor('post'), 'postPrograms', 'Award Implementation is policed on its own program list');
eq(programsKeyFor('inh'), 'programs', 'and the letters on theirs');

// ── Enumerating the applications ─────────────────────────────────────────────
const site = (name, programs) => (programs ? { name, programs } : { name });
// Shelter Cove: one campus, two programs, two applications.
eq(enumerateApplications(
  [{ key: 'federal', year: '2027' }, { key: 'california', year: '2026' }],
  [site('Main Campus', ['federal', 'california'])],
).map((a) => a.program.key), ['federal', 'california'], 'one site under two programs is two applications');

eq(enumerateApplications(
  [{ key: 'federal', year: '2026' }],
  [site('North'), site('South')],
).map((a) => a.location.name), ['North', 'South'], 'two sites under one program is two applications');

eq(enumerateApplications(
  [{ key: 'federal' }, { key: 'illinois' }],
  [site('A'), site('B')],
).length, 4, 'two sites under two programs is four');

// ── The division is exact ────────────────────────────────────────────────────
for (const [total, n] of [[22000, 2], [11000, 3], [15000, 2], [9500, 4], [1, 3], [0, 2], [7, 2]]) {
  const parts = divideFee(total, n);
  eq(parts.reduce((a, b) => a + b, 0), total, `${total} across ${n} letters still totals ${total}`);
  eq(parts.every((p) => Number.isInteger(p) && p >= 0), true, `  and every part is a whole dollar (${parts.join('/')})`);
  eq(Math.max(...parts) - Math.min(...parts) <= 1, true, '  and the parts differ by at most a dollar');
}

// ── The letters add up to the engagement they replaced ───────────────────────
// Exactly what splitPlan() does in App.jsx: divide the combined upfront and
// contingent, then price each letter as one application at those figures.
const combinedThenSplit = (model, tier, apps, { postAwardFee = '0', scope = false } = {}) => {
  const combined = calcFees(model, tier, apps, scope, postAwardFee, '', '', '');
  const up = divideFee(combined.upfront, apps);
  const con = divideFee(combined.contingent || 0, apps);
  const each = up.map((u, i) => calcFees(model, 'custom', 1, scope, postAwardFee,
    String(u), '', String(con[i])));
  return { combined, split: each.reduce((sum, f) => sum + f.total, 0) };
};

for (const model of ['partial-contingency', 'inh-partial-contingency']) {
  for (const apps of [2, 3]) {
    for (const tier of ['undiscounted', 'discounted']) {
      const { combined, split } = combinedThenSplit(model, tier, apps);
      eq(split, combined.total, `${model} ${tier} ${apps} apps: ${apps} letters total ${combined.total}, unchanged`);
    }
  }
}

// With the Compliance Period on, which is already charged per application and so
// must NOT be divided a second time.
for (const apps of [2, 3]) {
  const { combined, split } = combinedThenSplit('inh-partial-contingency', 'undiscounted', apps,
    { postAwardFee: '2,500', scope: true });
  eq(split, combined.total, `compliance period survives the split at ${apps} applications (${combined.total})`);
}

// The number the split is meant to protect: re-pricing at the table's
// one-application rate instead would raise this engagement by $6,000.
const naive = calcFees('partial-contingency', 'undiscounted', 1, false, 0, '', '', '').total * 2;
const real = calcFees('partial-contingency', 'undiscounted', 2, false, 0, '', '', '').total;
eq(naive - real, 6000, 'and the volume rate this preserves is worth $6,000 on two applications');

if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
