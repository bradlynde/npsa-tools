#!/usr/bin/env node
// Fee & letter-text parity harness.
//
// The generator is being reshaped into a stepped wizard and split out of App.jsx.
// None of that may move a number or a word in a client-facing letter, so this
// snapshots calcFees() and buildCompBlock() across a matrix of real engagement
// shapes and diffs later runs against the recorded baseline.
//
//   node scripts/fee-parity.mjs --save     record baseline (run before refactoring)
//   node scripts/fee-parity.mjs            compare against baseline; exit 1 on drift
//
// The engine is read out of its source file rather than imported, so the harness
// keeps working whether it lives in App.jsx or a module of its own.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "scripts", "fee-parity.baseline.json");

// Pull the pricing engine out of whichever file currently holds it.
function loadEngine() {
  const candidates = ["src/generator/engine.js", "src/App.jsx"];
  const file = candidates.map(f => path.join(ROOT, f)).find(fs.existsSync);
  if (!file) throw new Error("no engine source found");
  const src = fs.readFileSync(file, "utf8");

  const slice = (startRe, endRe) => {
    const a = src.search(startRe);
    if (a < 0) throw new Error(`not found in ${path.basename(file)}: ${startRe}`);
    const b = src.slice(a).search(endRe);
    if (b < 0) throw new Error(`no end for ${startRe}`);
    return src.slice(a, a + b);
  };

  const body = [
    // PRICING through fmt — TIER_LABELS and the currency formatter sit between them.
    slice(/const PRICING = \{/, /\nconst DEFAULT_PRE|\nexport /),
    slice(/function calcFees\(/, /\nfunction buildCompBlock/),
    slice(/function buildCompBlock\(/, /\nconst SHARED_FIELDS|\nconst POST_FIELDS/),
  ].join("\n");

  return new Function(`${body}\nreturn { PRICING, calcFees, buildCompBlock, buildInstallmentText };`)();
}

const MODELS = ["pre-only", "partial-contingency", "inh-pre-only", "inh-partial-contingency"];
const TIERS = ["undiscounted", "discounted", "max-discount", "custom"];

// Each case is a real shape a rep can produce in the sidebar today.
function* cases() {
  for (const model of MODELS) {
    for (const tier of TIERS) {
      for (const locs of [1, 2, 3]) {
        for (const scope of [false, true]) {
          for (const early of ["1,500", "500", ""]) {
            yield {
              name: `${model}|${tier}|${locs}loc|scope=${scope}|early=${early || "(blank)"}`,
              model, tier, locs,
              optPostAwardScope: scope,
              postAwardFee: "2,500",
              customFee: tier === "custom" ? "9,750" : "",
              earlySigningAmount: early,
              customContingencyFee: "",
            };
          }
        }
      }
    }
  }
  // Beyond the pricing table, where calcFees extrapolates from the 2->3 increment.
  for (const locs of [4, 7]) {
    yield {
      name: `pre-only|undiscounted|${locs}loc|extrapolated`,
      model: "pre-only", tier: "undiscounted", locs,
      optPostAwardScope: false, postAwardFee: "2,500",
      customFee: "", earlySigningAmount: "1,500", customContingencyFee: "",
    };
  }
}

function run() {
  const { calcFees, buildCompBlock } = loadEngine();
  const out = {};

  for (const c of cases()) {
    const fees = calcFees(
      c.model, c.tier, c.locs, c.optPostAwardScope, c.postAwardFee,
      c.customFee, c.earlySigningAmount, c.customContingencyFee,
    );

    // Exercise the compensation block both with and without an installment
    // schedule, since installment text is derived from the upfront figure.
    // Mirrors installmentsObj as App.jsx builds it (src/App.jsx:852).
    const schedule = {
      count: 3,
      payments: [
        { pct: "40", label: "at signing" },
        { pct: "30", label: "month 4" },
        { pct: "30", label: "month 8" },
      ],
    };

    const variants = {};
    for (const [label, inst] of [["flat", null], ["3x", schedule]]) {
      variants[label] = buildCompBlock(
        c.model, fees, inst, "2026", c.optPostAwardScope, c.postAwardFee,
        inst ? 3 : 0, "40", "at signing", "30", "month 4", "30", "month 8",
        c.tier === "discounted", "March 15, 2026", c.earlySigningAmount,
      );
    }

    out[c.name] = { fees, text: variants };
  }
  return out;
}

const results = run();
const save = process.argv.includes("--save");

if (save) {
  fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2) + "\n");
  console.log(`baseline saved: ${Object.keys(results).length} cases -> ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error("no baseline recorded; run with --save first");
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const drift = [];

for (const name of new Set([...Object.keys(base), ...Object.keys(results)])) {
  const a = JSON.stringify(base[name]);
  const b = JSON.stringify(results[name]);
  if (a !== b) drift.push({ name, before: base[name], after: results[name] });
}

if (!drift.length) {
  console.log(`fee parity OK — ${Object.keys(results).length} cases identical to baseline`);
  process.exit(0);
}

console.error(`FEE PARITY DRIFT — ${drift.length} of ${Object.keys(base).length} cases changed:\n`);
for (const d of drift.slice(0, 8)) {
  console.error(`  ${d.name}`);
  const fa = d.before?.fees, fb = d.after?.fees;
  if (JSON.stringify(fa) !== JSON.stringify(fb)) {
    console.error(`    fees before: ${JSON.stringify(fa)}`);
    console.error(`    fees after : ${JSON.stringify(fb)}`);
  }
  for (const v of ["flat", "3x"]) {
    if (d.before?.text?.[v] !== d.after?.text?.[v]) {
      console.error(`    text[${v}] differs`);
    }
  }
}
if (drift.length > 8) console.error(`  ...and ${drift.length - 8} more`);
process.exit(1);
