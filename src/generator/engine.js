// Pricing tables and fee arithmetic for engagement letters.
//
// Pure module: no React, no DOM. scripts/fee-parity.mjs imports this directly
// to prove that UI work never moves a number in a client-facing letter.

// ─── PRICING TABLES ───────────────────────────────────────────────────────────
const PRICING = {
  "pre-only": {
    label: "Pre-Award Only",
    tiers: {
      undiscounted: { 1: 4000, 2: 8000, 3: 12000 },
      discounted:   { 1: 3500,  2: 7000, 3: 10500 },
      max:          { 1: 8000,  2: 13500, 3: 18000 },
    },
    contingent: null,
  },
  "partial-contingency": {
    label: "Pre-Award + Partial Contingency",
    tiers: {
      undiscounted: { upfront: { 1: 3000, 2: 6000, 3: 9000 }, contingent: { 1: 11000, 2: 16000, 3: 22000 } },
      discounted:   { upfront: { 1: 2000, 2: 4000, 3: 6000 }, contingent: { 1: 9000,  2: 14000, 3: 19000 } },
      max:          { upfront: { 1: 0,    2: 0,    3: 0    }, contingent: { 1: 11000, 2: 18000, 3: 25000 } },
    },
  },
  "inh-pre-only": {
    label: "Pre-Award Only (In-House)",
    tiers: {
      undiscounted: { 1: 11000, 2: 18000, 3: 25000 },
      discounted:   { 1: 9500,  2: 15000, 3: 20500 },
      max:          { 1: 8000,  2: 13500, 3: 18000 },
    },
    contingent: null,
  },
  "inh-partial-contingency": {
    label: "Pre-Award + Partial Contingency (In-House)",
    tiers: {
      undiscounted: { upfront: { 1: 3000, 2: 6000, 3: 9000 }, contingent: { 1: 11000, 2: 16000, 3: 22000 } },
      discounted:   { upfront: { 1: 2000, 2: 4000, 3: 6000 }, contingent: { 1: 9000,  2: 14000, 3: 19000 } },
      max:          { upfront: { 1: 0,    2: 0,    3: 0    }, contingent: { 1: 11000, 2: 18000, 3: 25000 } },
    },
  },
};
const TIER_LABELS = { undiscounted: "Undiscounted", discounted: "Early Signing Discount", max: "Max Discount", custom: "Custom" };
const fmt = (n) => n === 0 ? "$0" : `$${Number(n).toLocaleString()}`;

function calcFees(model, tier, locs, optPostAwardScope, postAwardFee, customFee, earlySigningAmount, customContingencyFee) {
  const n = Math.max(parseInt(locs) || 1, 1); // no cap — extrapolate beyond 3
  const isEarlySigning = tier === "discounted";
  const effectiveTier = isEarlySigning ? "undiscounted" : tier; // use undiscounted base to apply discount cleanly
  const discountPerLoc = isEarlySigning ? (parseFloat(String(earlySigningAmount).replace(/,/g,"")) || 0) : 0;
  const discount = discountPerLoc * n;
  const postAward = optPostAwardScope ? (parseFloat(String(postAwardFee).replace(/,/g,"")) || 0) * n : 0;
  const isPreOnly = model === "pre-only" || model === "inh-pre-only";
  // Helper: look up table value, extrapolating linearly beyond 3 using the 2→3 increment
  const lookup = (tbl) => {
    if (n <= 3) return tbl[n] || 0;
    return (tbl[3] || 0) + (n - 3) * ((tbl[3] || 0) - (tbl[2] || 0));
  };
  if (tier === "custom") {
    const fee = Math.max(0, (parseFloat(String(customFee).replace(/,/g,"")) || 0) - discount);
    return { upfront: fee, baseUpfront: parseFloat(String(customFee).replace(/,/g,"")) || 0, discount, contingent: null, postAward: optPostAwardScope ? postAward : null, total: fee + postAward };
  }
  if (isPreOnly) {
    const pricing = PRICING[model] || PRICING["pre-only"];
    const base = lookup(pricing.tiers[effectiveTier] || {});
    const fee = Math.max(0, base - discount);
    return { upfront: fee, baseUpfront: base, discount, contingent: null, postAward: optPostAwardScope ? postAward : null, total: fee + postAward };
  } else {
    const pricing = PRICING[model] || PRICING["partial-contingency"];
    // Partial contingency uses the pricing sheet's explicit per-tier schedule rather than a
    // flat per-location discount: the discount differs between the upfront and contingent
    // fees, so it cannot be derived by subtracting a single amount from the undiscounted row.
    const baseTier = pricing.tiers.undiscounted || {};
    const rateTier = pricing.tiers[tier] || baseTier;
    const base = lookup(baseTier.upfront || {});
    const up = lookup(rateTier.upfront || {});
    const con = customContingencyFee
      ? (parseFloat(String(customContingencyFee).replace(/,/g,"")) || 0)
      : lookup(rateTier.contingent || {});
    return { upfront: up, baseUpfront: base, discount: Math.max(0, base - up), contingent: con, postAward: optPostAwardScope ? postAward : null, total: up + con + postAward };
  }
}
function buildInstallmentText(installments, upfront) {
  if (!installments || !installments.count) return "";
  const { count, payments } = installments;
  const lines = payments.slice(0, count).map((p, i) => {
    const pct = parseFloat(p.pct) || 0;
    const amt = Math.round(upfront * pct / 100);
    return `       ${i+1}. ${fmt(amt)} (${pct}%) ${p.label||""}`.trimEnd();
  });
  return `\n\n   By agreement of the parties, this fee shall be paid in ${count === 2 ? "two (2)" : "three (3)"} installments as follows:\n${lines.join("\n")}`;
}
function buildCompBlock(model, fees, installments, grantYear, optPostAwardScope, postAwardFee, installmentCount, i1Pct, i1Label, i2Pct, i2Label, i3Pct, i3Label, earlySigningDiscount, earlySigningDate, earlySigningAmount) {
  const isInh = model.startsWith("inh-");
  const baseModel = isInh ? model.replace("inh-","") : model;
  let text = "";
  if (baseModel === "pre-only") {
    // Section A
    text = `A. NPSA Pre-Award Consulting Fee\n\n1. CLIENT will pay NPSA ${fmt(fees.upfront)} upon execution of this Engagement Letter. This fee includes the combined costs below.`;
    if (installments) text += buildInstallmentText(installments, fees.upfront);
    text += `\n   (a) If CLIENT provides written notice of cancellation after executing this Agreement and prior to NPSA delivering a completed grant application ready for submission, the Agreement will be cancelled but no refunds will be issued.`;
    if (!isInh) {
      text += `\n\nB. Third-Party Grant Writer\n\n1. CLIENT will pay a third-party grant writer for grant writing services. These costs are not listed in this Engagement Letter because CLIENT must contract directly with the third party grant writer outside of NPSA's direction or control to remain in compliance with NSGP rules.`;
    }
  } else {
    // Section A — partial contingency
    text = `A. NPSA Pre-Award Consulting Fee\n\n1. Upfront Fee. CLIENT will pay NPSA ${fmt(fees.upfront)} upon execution of this Engagement Letter. This fee includes the combined costs below.`;
    if (fees.upfront === 0) text = `A. NPSA Pre-Award Consulting Fee\n\n1. Upfront Fee. No upfront fee is due upon execution of this Engagement Letter under this engagement model.`;
    if (installments && fees.upfront > 0) text += buildInstallmentText(installments, fees.upfront);
    text += `\n   (a) If CLIENT provides written notice of cancellation after executing this Agreement and prior to NPSA delivering a completed grant application ready for submission, the Agreement will be cancelled but no refunds will be issued.`;
    text += `\n\n2. Contingent Fee. Upon notification of a grant award, CLIENT will pay NPSA an additional ${fmt(fees.contingent)}. This fee is due upon award notification and is not reimbursable by grant funds.`;
    if (!isInh) text += `\n\nB. Third-Party Grant Writer\n\n1. CLIENT will pay a third-party grant writer for grant writing services directly, outside of NPSA's direction or control, to remain in compliance with NSGP rules.`;
  }
  // Gate on the discount actually applied, not on the operator's input field. Partial
  // contingency takes its discounted fees straight from the pricing table and ignores
  // earlySigningAmount, so keying off that field would drop the execution deadline from
  // a discounted letter — giving the discount away with no date attached to hold it to.
  if (earlySigningDiscount && earlySigningDate && fees.discount > 0) {
    text += `\n\n[EARLY_SIGNING_DISCOUNT:${earlySigningDate}:${fmt(fees.discount)}:${fmt(fees.baseUpfront)}]`;
  }
  // Post-Award Consulting and Administrative Support Fee block — shown when toggle is on
  if (optPostAwardScope) {
    const postAwardLabel = isInh ? "B" : "C";
    text += `\n\n${postAwardLabel}. Compliance Period Fee\n\n`;
    text += `1. In the event CLIENT is awarded funding under the ${grantYear} NSGP, CLIENT agrees to pay NPSA a fixed fee of ${fmt(fees.postAward)} for the Compliance Period services described in this Engagement Letter.\n`;
    text += `2. This fee is not contingent upon the amount of funding awarded and is not calculated as a percentage of any grant award. Rather, this fee reflects the additional administrative workload required of NPSA upon award and covers services provided from award notification to receipt of formal written clearance from the State authorizing CLIENT to begin committing grant funds.\n`;
    text += `3. The Compliance Period fee shall be due within thirty (30) days of CLIENT'S receipt of award notification.\n`;
    text += `4. All fees payable to NPSA under this Engagement Letter are non-reimbursable from grant funds and shall not be charged to, paid from, or otherwise included in any grant-funded budget or reimbursement request. CLIENT acknowledges that such fees are the sole financial responsibility of CLIENT.`;
  } else {
    text += `\n\nNote: None of the above costs are reimbursable from grant funds.`;
  }
  return text;
}
const SHARED_FIELDS = [
  { section:"Client Information" },
  { key:"clientName", label:"Organization Name", placeholder:"e.g. First Baptist Church" },
  { key:"contactName", label:"Primary Contact Name", placeholder:"e.g. Jane Smith" },
  { key:"contactTitle", label:"Contact Title", placeholder:"Pastor, Executive Director" },
  { key:"contactEmail", label:"Email", placeholder:"e.g. jane@organization.org" },
  { key:"contactPhone", label:"Phone", placeholder:"(xxx) xxx-xxxx", formatFn:(v)=>{const d=v.replace(/\D/g,"").slice(0,10);if(d.length<=3)return d;if(d.length<=6)return `(${d.slice(0,3)}) ${d.slice(3)}`;return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;} },
];
const POST_FIELDS = [
  { section:"Compensation" },
  { key:"postFee", label:"Total Fixed Fee ($)", placeholder:"7,000" },
  { key:"postEffectiveDate", label:"Effective Date", type:"date" },
  { key:"postPmt1", label:"Payment 1 — At Signing (%)", placeholder:"40" },
  { key:"postPmt2", label:"Payment 2 — Month 4 (%)", placeholder:"30" },
  { key:"postPmt3", label:"Payment 3 — Month 8 (%)", placeholder:"30" },
];

// ─── PROGRAM CONFIG ───────────────────────────────────────────────────────────
const PROGRAMS = {
  federal:    { label:"Federal NSGP",     acronym:"NSGP",    maxAward:"200,000", fullName:(yr)=>`${yr} Federal Nonprofit Security Grant Program ("NSGP")` },
  illinois:   { label:"Illinois (NSGP-IL)", acronym:"NSGP-IL", maxAward:"150,000", fullName:(yr)=>`${yr} Illinois Nonprofit Security Grant Program ("NSGP-IL")` },
  california: { label:"California (CSNSGP)", acronym:"CSNSGP", maxAward:"250,000", fullName:(yr)=>`${yr} California State Nonprofit Security Grant Program ("CSNSGP")` },
  newyork:    { label:"New York (NYSCAHC)", acronym:"NYSCAHC", maxAward:"200,000", fullName:(yr)=>`${yr} New York Securing Communities Against Hate Crimes ("NYSCAHC")` },
};
/**
 * Total maximum award across an engagement: each program's own cap times the
 * number of locations applying under it. Caps are not uniform — Illinois is
 * $150,000 and California $250,000 against the federal $200,000 — so this
 * cannot be shortcut to a flat per-location figure.
 *
 * Award Implementation prices from this at 5%.
 */
function totalMaxAward(programs, locations) {
  return (programs || []).reduce((sum, pg) => {
    const cfg = PROGRAMS[pg.key] || PROGRAMS.federal;
    const n = (locations || []).filter((l) => (l.programs || ["federal"]).includes(pg.key)).length;
    return sum + n * (parseFloat(String(cfg.maxAward).replace(/,/g, "")) || 0);
  }, 0);
}

// ─── NPSA SIGNATURE STYLES ────────────────────────────────────────────────────
const NPSA_SIGNATURES = {
  "Brad Lynde":     { font:"'Ms Madi', cursive", size:"38px", color:"#182230" },
  "Chad Burgess":   { font:"'Ms Madi', cursive", size:"38px", color:"#182230" },
  "Josh Ullrich":   { font:"'Ms Madi', cursive", size:"38px", color:"#182230" },
  "Steven Timlick": { font:"'Ms Madi', cursive", size:"38px", color:"#182230" },
  "Stuart Reese":   { font:"'Ms Madi', cursive", size:"38px", color:"#182230" },
};

export {
  PRICING, TIER_LABELS, fmt,
  calcFees, buildInstallmentText, buildCompBlock,
  SHARED_FIELDS, POST_FIELDS,
  PROGRAMS, NPSA_SIGNATURES,
  totalMaxAward,
};
