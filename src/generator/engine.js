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

function calcFees(model, tier, locs, optPostAwardScope, postAwardFee, customFee, earlySigningAmount, customContingencyFee, contingentDiscount, splitShare) {
  const n = Math.max(parseInt(locs) || 1, 1); // no cap — extrapolate beyond 3
  const money = (v) => parseFloat(String(v).replace(/,/g, "")) || 0;
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
  /*
   * One share of an engagement that was split into a letter per application.
   *
   * The share carries its own arithmetic — figures, discount and the bases the
   * discount was taken from — so the letter keeps its pricing TIER rather than
   * becoming a custom-priced one. That is what lets the early signing clause
   * still print: it is gated on the tier, so a split letter that quietly became
   * "custom" dropped its sign-by date and gave the discount away with no
   * deadline attached to hold the client to. Stuart: "yes it needs to be able to
   * carry any discounts if they are applied."
   */
  if (splitShare && splitShare.upfront != null) {
    const up = money(splitShare.upfront);
    const con = splitShare.contingent == null ? null : money(splitShare.contingent);
    return {
      upfront: up,
      baseUpfront: splitShare.baseUpfront != null ? money(splitShare.baseUpfront) : up,
      discount: money(splitShare.discount),
      ...(splitShare.discountOn ? { discountOn: splitShare.discountOn } : {}),
      ...(splitShare.contingentBase != null ? { contingentBase: money(splitShare.contingentBase) } : {}),
      contingent: con,
      postAward: optPostAwardScope ? postAward : null,
      total: up + (con || 0) + postAward,
    };
  }

  if (isPreOnly) {
    if (tier === "custom") {
      const fee = money(customFee);
      return { upfront: fee, baseUpfront: fee, discount: 0, contingent: null, postAward: optPostAwardScope ? postAward : null, total: fee + postAward };
    }
    const pricing = PRICING[model] || PRICING["pre-only"];
    const base = lookup(pricing.tiers[effectiveTier] || {});
    const fee = Math.max(0, base - discount);
    return { upfront: fee, baseUpfront: base, discount, contingent: null, postAward: optPostAwardScope ? postAward : null, total: fee + postAward };
  } else {
    const pricing = PRICING[model] || PRICING["partial-contingency"];
    const baseTier = pricing.tiers.undiscounted || {};
    const rateTier = pricing.tiers[tier] || baseTier;
    // The override wins wherever a contingent fee is quoted, so it is read once here
    // rather than at each of the three exits below.
    const contingentFrom = (t) => customContingencyFee ? money(customContingencyFee) : lookup(t.contingent || {});

    /*
     * Custom sets the UPFRONT fee. It used to be handled before this branch was
     * reached, which returned contingent: null on a contingency engagement — the
     * letter then printed "CLIENT will pay NPSA an additional $0" while the
     * Contingency Fee Override sat on screen doing nothing. A rep reaching for
     * Custom is naming a different upfront number, not converting the deal to a
     * flat fee; Pre-Award Only is how you do that.
     */
    if (tier === "custom") {
      const up = money(customFee);
      const con = contingentFrom(baseTier);
      return { upfront: up, baseUpfront: up, discount: 0, contingent: con, postAward: optPostAwardScope ? postAward : null, total: up + con + postAward };
    }

    /*
     * A negotiated discount comes off the CONTINGENT fee.
     *
     * Stuart: "it would need to discount the contingent fee, we want to keep as
     * much up front." So a typed amount holds the upfront at its undiscounted
     * figure and reduces what is owed on award — the opposite of the pricing
     * table's discounted row, which cuts the upfront as well and is what a rep is
     * overriding by typing a number at all.
     *
     * It has its own field rather than reusing earlySigningAmount, which is
     * prefilled ("500", or "1,500" in-house) and invisible on this model: reading
     * that here would have silently re-priced every contingency letter already
     * saved at the discounted tier.
     */
    const typed = isEarlySigning ? money(contingentDiscount) * n : 0;
    if (typed > 0) {
      const up = lookup(baseTier.upfront || {});
      const contingentBase = contingentFrom(baseTier);
      const con = Math.max(0, contingentBase - typed);
      return { upfront: up, baseUpfront: up, discount: typed, discountOn: "contingent", contingentBase,
               contingent: con, postAward: optPostAwardScope ? postAward : null, total: up + con + postAward };
    }

    // Partial contingency uses the pricing sheet's explicit per-tier schedule rather than a
    // flat per-location discount: the discount differs between the upfront and contingent
    // fees, so it cannot be derived by subtracting a single amount from the undiscounted row.
    const base = lookup(baseTier.upfront || {});
    const up = lookup(rateTier.upfront || {});
    const con = contingentFrom(rateTier);
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
function buildCompBlock(model, fees, installments, grantYear, optPostAwardScope, postAwardFee, installmentCount, i1Pct, i1Label, i2Pct, i2Label, i3Pct, i3Label, earlySigningDiscount, earlySigningDate, earlySigningAmount, programs) {
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
    /*
     * Contingent Grant Award Fee — the clause Brad approved on 2026-09-10.
     *
     * It replaced "an additional $X ... due upon award notification", which said
     * nothing about a partial award. A client reading that fairly could not tell
     * what they owed on an award smaller than the one they asked for, and working
     * that out in correspondence is what turned the Shelter Cove letter into a
     * round of clarifications.
     *
     * Two things in here are load-bearing. The fee is proportional to
     * awarded ÷ REQUESTED, never to the program maximum — so the maximum is named
     * only to reassure a client who asks for less than it, and is labelled
     * non-operative in the same breath, because a figure sitting in the paragraph
     * is otherwise an invitation to argue it is the denominator. And the maximum
     * is only stated when this letter runs ONE program: two programs have two
     * different caps ($200,000 federal, $250,000 CSNSGP), and naming either as
     * "the program maximum" would be false. That case should stop existing once a
     * contingent letter is held to one application, but the clause must not lie in
     * the meantime.
     */
    const named = (programs || []).filter((p) => PROGRAMS[p.key]);
    const caps = named.map((p) => `$${PROGRAMS[p.key].maxAward} per site under the ${PROGRAMS[p.key].fullName(p.year || grantYear)}`);
    const listed = caps.length > 2
      ? `${caps.slice(0, -1).join(", ")}, and ${caps[caps.length - 1]}`
      : caps.join(" and ");
    // Brad's sentence, kept word for word on one program and pluralised on more.
    // It used to drop out entirely when a letter ran two, which left the reader
    // with a proportional fee and no idea what it was proportional to — and the
    // clause reads on every engagement or it is not finished.
    const cap = caps.length
      ? ` The program ${caps.length === 1 ? "maximum" : "maximums"} — currently ${listed} — ${caps.length === 1 ? "is" : "are"} stated for reference only and ${caps.length === 1 ? "is" : "are"} not used to calculate this fee.`
      : "";
    const max = fmt(fees.contingent);
    text += `\n\n2. Contingent Grant Award Fee.`;
    text += `\n   (a) A Contingent Grant Award Fee of up to ${max} is earned only if CLIENT receives a grant award for the application NPSA prepares and submits under this Engagement Letter, including any resubmission of that application under a subsequent funding cycle as provided in the Guarantees of NPSA. If no award is made for that application, no Contingent Grant Award Fee is due.`;
    text += `\n   (b) For purposes of this Section, "Amount Requested" means the total dollar amount requested in that application as submitted to the administering agency, and "Amount Awarded" means the total dollar amount awarded to CLIENT for that same application.`;
    text += `\n   (c) If CLIENT is awarded the full Amount Requested, the Contingent Grant Award Fee is the full ${max}. This applies regardless of whether CLIENT elects to request less than the maximum available under the program.${cap}`;
    text += `\n   (d) If CLIENT is awarded less than the Amount Requested, the Contingent Grant Award Fee is reduced in the same proportion, calculated as: Contingent Grant Award Fee = ${max} × (Amount Awarded ÷ Amount Requested), not to exceed ${max}.`;
    text += `\n   (e) The Contingent Grant Award Fee is due within thirty (30) days of CLIENT's receipt of award notification and is not reimbursable from grant funds.`;
    if (!isInh) text += `\n\nB. Third-Party Grant Writer\n\n1. CLIENT will pay a third-party grant writer for grant writing services directly, outside of NPSA's direction or control, to remain in compliance with NSGP rules.`;
  }
  // Gate on the discount actually applied, not on the operator's input field. Partial
  // contingency takes its discounted fees straight from the pricing table and ignores
  // earlySigningAmount, so keying off that field would drop the execution deadline from
  // a discounted letter — giving the discount away with no date attached to hold it to.
  if (earlySigningDiscount && earlySigningDate && fees.discount > 0) {
    // Which fee the discount came off is part of the sentence, not a detail: a
    // contingency letter that says a discount "has been applied to the standard
    // $3,000 consulting fee" would be describing a reduction the client never got,
    // since the upfront is held at full and the contingent is what moved.
    const onContingent = fees.discountOn === "contingent";
    const against = onContingent ? fees.contingentBase : fees.baseUpfront;
    text += `\n\n[EARLY_SIGNING_DISCOUNT:${earlySigningDate}:${fmt(fees.discount)}:${fmt(against)}${onContingent ? ":contingent" : ""}]`;
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
/** ISO yyyy-mm-dd for today plus `days`, in local time. */
function isoDatePlus(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Which of this engagement's programs a location applies under.
 *
 * A location records its own list only when there is a choice to record: the
 * per-location chips appear when the engagement runs more than one program, and
 * a one-program letter has nothing to pick between. So an unrecorded list means
 * "all of them", not "none of them".
 *
 * A list is also intersected with the engagement rather than trusted whole. A
 * letter that started federal and moved to CSNSGP leaves "federal" written on
 * its locations, naming a program the engagement no longer runs — the stale
 * value is dropped, and a location left naming nothing this engagement runs
 * falls back to all of them, the same as one that never recorded a choice.
 *
 * This was thirteen copies of `l.programs || ["federal"]`, which answered the
 * question with a literal program key. Federal is the common case and the
 * default location carried ["federal"] to match, so every federal letter was
 * right and every state-program letter counted ZERO locations: a $0 maximum
 * award on the page, and multi-site CSNSGP, NSGP-IL and NYSCAHC engagements
 * priced as a single application.
 */
function locationPrograms(location, programs) {
  const keys = (programs || []).map((p) => p.key);
  const recorded = Array.isArray(location?.programs) ? location.programs.filter((k) => keys.includes(k)) : [];
  return recorded.length ? recorded : keys;
}

/** Does this location apply under this program? */
function locationInProgram(location, programKey, programs) {
  return locationPrograms(location, programs).includes(programKey);
}

/**
 * Applications in an engagement: one per location, per program it applies
 * under. Fees scale on this rather than on the location count — a single site
 * applying to two programs is two applications and is priced as two.
 */
function applicationCount(programs, locations) {
  const list = programs && programs.length ? programs : [{ key: "federal" }];
  return list.reduce(
    (sum, pg) => sum + (locations || []).filter((l) => locationInProgram(l, pg.key, list)).length,
    0,
  ) || 1;
}

/**
 * Which form key holds a document's programs. Award Implementation, the grant
 * writer agreement and the addendum each keep their own list.
 */
function programsKeyFor(docTab) {
  return docTab === "post" ? "postPrograms"
    : docTab === "gw" ? "gwPrograms"
      : docTab === "addendum" ? "addendumPrograms" : "programs";
}

/**
 * Documents that must carry exactly one application.
 *
 * Brad, asked whether every multi-program engagement should be split: "No. We
 * only need Implementation contracts and all contingent contracts to be one
 * contract per app." So a flat Pre-Award Only letter may still cover a whole
 * engagement, and these two may not — a contingent fee and an implementation
 * fee both hang off the outcome of one application, and blending two of them
 * into one contract is what nobody can answer questions about afterwards.
 */
function oneApplicationPerLetter(docTab, model) {
  if (docTab === "post") return true;
  return String(model || "").endsWith("partial-contingency");
}

/**
 * Every application in an engagement, in the order a rep would read them: each
 * program paired with each location applying under it.
 */
function enumerateApplications(programs, locations) {
  const list = programs && programs.length ? programs : [{ key: "federal" }];
  const out = [];
  for (const program of list) {
    for (const location of locations || []) {
      if (locationInProgram(location, program.key, list)) out.push({ program, location });
    }
  }
  return out;
}

/**
 * Split a fee into n whole-dollar parts that still add up to it.
 *
 * Stuart's rule for the split: the client pays what the combined letter quoted,
 * so the division has to be exact. $11,000 across three is 3667/3667/3666 — the
 * remainder goes to the earlier letters rather than being rounded away, because
 * three letters that sum to $11,001 is a worse answer than an uneven cent.
 */
function divideFee(total, n) {
  const whole = Math.max(0, Math.round(Number(total) || 0));
  const count = Math.max(1, Math.floor(n) || 1);
  const base = Math.floor(whole / count);
  const extra = whole - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

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
    const n = (locations || []).filter((l) => locationInProgram(l, pg.key, programs)).length;
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
  totalMaxAward, applicationCount, locationPrograms, locationInProgram, isoDatePlus,
  programsKeyFor, oneApplicationPerLetter, enumerateApplications, divideFee,
};
