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
  buildCompBlock, calcFees, divideFee, enumerateApplications, oneApplicationPerLetter, programsKeyFor,
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

/*
 * A discount survives the split.
 *
 * Stuart: "yes it needs to be able to carry any discounts if they are applied."
 * The share carries the discount and the base it was taken from, so each letter
 * still prints its early signing clause — a split letter that lost it would be
 * giving the discount away with no sign-by date attached to hold the client to.
 */
const shareOf = (combined, n, i) => ({
  upfront: divideFee(combined.upfront, n)[i],
  contingent: combined.contingent == null ? null : divideFee(combined.contingent, n)[i],
  discount: divideFee(combined.discount || 0, n)[i],
  baseUpfront: divideFee(combined.baseUpfront ?? combined.upfront, n)[i],
  ...(combined.discountOn
    ? { discountOn: combined.discountOn, contingentBase: divideFee(combined.contingentBase ?? 0, n)[i] }
    : {}),
});

for (const model of ['partial-contingency', 'inh-partial-contingency']) {
  for (const n of [2, 3]) {
    const combined = calcFees(model, 'discounted', n, false, 0, '', '', '');
    const shares = Array.from({ length: n }, (_, i) =>
      calcFees(model, 'discounted', 1, false, 0, '', '', '', '', shareOf(combined, n, i)));

    eq(shares.reduce((t, f) => t + f.total, 0), combined.total,
      `${model}: a discounted engagement across ${n} letters still totals ${combined.total}`);
    eq(shares.reduce((t, f) => t + f.discount, 0), combined.discount,
      `  and the ${combined.discount} discount is divided, not dropped`);
    eq(shares.every((f) => f.discount > 0), true, '  with every letter carrying a share of it');

    // The clause is gated on the tier, which is exactly why the share keeps it.
    const clause = buildCompBlock(model, shares[0], null, '2026', false, 0, 0, '', '', '', '', '', '',
      true, '2026-10-01', '', [{ key: 'california', year: '2026' }]);
    eq(/\[EARLY_SIGNING_DISCOUNT:2026-10-01:/.test(clause), true,
      '  and the early signing clause still prints on a split letter');
  }
}

// A contingent-side discount divides the same way, against the contingent base.
{
  const combined = calcFees('partial-contingency', 'discounted', 2, false, 0, '', '500', '', '4000');
  eq(combined.discountOn, 'contingent', 'a typed discount is taken off the contingent fee');
  const share = calcFees('partial-contingency', 'discounted', 1, false, 0, '', '500', '', '4000',
    shareOf(combined, 2, 0));
  eq(share.discountOn, 'contingent', '  and the share remembers which fee it came off');
  eq(share.discount * 2, combined.discount, '  and divides it exactly');
  const clause = buildCompBlock('partial-contingency', share, null, '2026', false, 0, 0, '', '', '', '', '', '',
    true, '2026-10-01', '', [{ key: 'california', year: '2026' }]);
  eq(/:contingent\]/.test(clause), true, '  so the letter still says the contingent fee was discounted');
}

// An undiscounted engagement gains no clause it never had.
{
  const combined = calcFees('partial-contingency', 'undiscounted', 2, false, 0, '', '', '');
  const share = calcFees('partial-contingency', 'undiscounted', 1, false, 0, '', '', '', '', shareOf(combined, 2, 0));
  eq(share.discount, 0, 'an undiscounted split letter carries no discount');
  const clause = buildCompBlock('partial-contingency', share, null, '2026', false, 0, 0, '', '', '', '', '', '',
    false, '', '', [{ key: 'california', year: '2026' }]);
  eq(/EARLY_SIGNING_DISCOUNT/.test(clause), false, '  and prints no early signing clause');
}

// The number the split is meant to protect: re-pricing at the table's
// one-application rate instead would raise this engagement by $6,000.
const naive = calcFees('partial-contingency', 'undiscounted', 1, false, 0, '', '', '').total * 2;
const real = calcFees('partial-contingency', 'undiscounted', 2, false, 0, '', '', '').total;
eq(naive - real, 6000, 'and the volume rate this preserves is worth $6,000 on two applications');

if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
