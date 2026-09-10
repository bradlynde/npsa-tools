/*
 * The engagement-letter wizard shell.
 *
 * Owns navigation, progress and the fee bar; the steps themselves come from
 * steps.jsx and the controls from ui.jsx. It never renders letter text, so
 * client-facing wording stays exactly where it was.
 *
 * Renders the form column only. App owns the .wz grid and keeps the letter
 * preview as a sibling, so ~700 lines of letter markup never had to move. On a
 * phone that column is hidden until the review step (see wizard.css).
 */

import { useEffect } from "react";
import {
  fmt, calcFees, totalMaxAward, applicationCount, isoDatePlus, PROGRAMS, TIER_LABELS,
  programsKeyFor, oneApplicationPerLetter,
} from "./engine.js";

/** Long-form date for display; passes through free text from older letters. */
const fmtDate = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v || "")
    ? new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : v || "";
import { RadioCards, Chips, Field } from "./ui.jsx";
import { stepsFor } from "./steps.jsx";

/*
 * Document types as the tab bar already groups them: Pre-Award covers both
 * variants, and picking it lands on In-House unless the rep says otherwise.
 */
export const DOC_TYPES = [
  {
    id: "pre",
    label: "Pre-Award",
    description: "Engagement letter for pre-award consulting and application work.",
    tabs: ["inh", "pre"],
    defaultTab: "inh",
  },
  { id: "post", label: "Award Implementation", description: "Post-award administration and compliance support.", tab: "post" },
  { id: "gw", label: "3rd Party Grant Writer", description: "Agreement with an outside grant writer.", tab: "gw" },
  { id: "proposal", label: "Proposal", description: "Pre-engagement proposal, not a signed contract.", tab: "proposal" },
  { id: "addendum", label: "Addendum", description: "Amends an engagement letter already in force.", tab: "addendum" },
];

const VARIANTS = [
  { value: "inh", label: "In-House Grant Writing" },
  { value: "pre", label: "Third Party Grant Writing" },
];

const groupOf = (docTab) =>
  DOC_TYPES.find((d) => d.tab === docTab || (d.tabs || []).includes(docTab))?.id || "pre";

/* ── the document-type step ──────────────────────────────────────────── */

function DocTypeStep({ docTab, onDocTab }) {
  const group = groupOf(docTab);
  return (
    <>
      <RadioCards
        name="doctype"
        value={group}
        onChange={(id) => {
          const d = DOC_TYPES.find((x) => x.id === id);
          onDocTab(d.tab || d.defaultTab);
        }}
        options={DOC_TYPES.map((d) => ({ value: d.id, label: d.label, description: d.description }))}
      />
      {group === "pre" && (
        <Field
          label="Engagement Variant"
          hint={docTab === "inh"
            ? "NPSA manages grant writing, application preparation and submission."
            : "An outside grant writer prepares the applications; NPSA advises on compliance."}
        >
          <Chips value={docTab} onChange={onDocTab} options={VARIANTS} />
        </Field>
      )}
    </>
  );
}

/* ── review ──────────────────────────────────────────────────────────── */

function ReviewStep({ form, docTab, fees, numLocs, signByKey, tierKey }) {
  const label = DOC_TYPES.find((d) => d.tab === docTab || (d.tabs || []).includes(docTab))?.label;
  const variant = docTab === "inh" ? "In-House" : docTab === "pre" ? "Third Party" : null;
  const isInh = docTab === "inh";

  // Each document stores its party under its own key. Falling back across them
  // would show the pre-award client on a grant-writer agreement addressed to
  // someone else entirely.
  const party = docTab === "gw"
    ? ["Recipient", form.gwRecipientName]
    : docTab === "addendum"
      ? ["Client", form.addendumClientName]
      : ["Client", form.clientName];

  const programsKey = docTab === "post" ? "postPrograms"
    : docTab === "gw" ? "gwPrograms"
      : docTab === "addendum" ? "addendumPrograms" : "programs";
  const programs = (form[programsKey] || [])
    .map((p) => `${(PROGRAMS[p.key] || PROGRAMS.federal).acronym} ${p.year || ""}`.trim())
    .join(", ");

  // Site names only — the full addresses belong in the letter, not the summary.
  // Unnamed sites fall back to their city, which reps recognise; the bare index
  // told them nothing.
  const sites = (form.locations || [])
    .map((l, i) => l.name || l.city || `Site ${i + 1}`)
    .filter(Boolean)
    .join(", ");

  // The terms a rep most often needs to sanity-check before sending.
  const terms = [];
  if (docTab === "pre" || docTab === "inh" || docTab === "proposal") {
    const model = form[isInh ? "inhEngagementModel" : "engagementModel"];
    terms.push(String(model || "").includes("partial-contingency")
      ? "Pre-Award + Partial Contingency" : "Pre-Award Only");
    terms.push(TIER_LABELS[form[tierKey]] || "Undiscounted");
    if (form[isInh ? "inhOptPostAwardScope" : "optPostAwardScope"]) {
      terms.push(fees?.postAward
        ? `Compliance Period services (${fmt(fees.postAward)})`
        : "Compliance Period services");
    }
    if (form[isInh ? "inhOptShortNotice" : "optShortNotice"]) terms.push("Short notice");
    if (form[isInh ? "inhOptNofo" : "optNofo"]) terms.push("NOFO referenced");
  }

  const rows = [[party[0], party[1] || "—"]];
  if (form.contactName && docTab !== "gw" && docTab !== "addendum") {
    rows.push(["Primary contact", form.contactName]);
  }
  rows.push(["Document", variant ? `${label} · ${variant}` : label]);
  if (programs) rows.push(["Programs", programs]);
  if (sites && docTab !== "gw" && docTab !== "addendum") {
    rows.push([`Location${(form.locations || []).length === 1 ? "" : "s"}`, sites]);
  }
  if (docTab !== "gw" && docTab !== "addendum") rows.push(["Applications", numLocs]);
  if (terms.length) rows.push(["Terms", terms.join(" · ")]);
  if (form[tierKey] === "discounted" && form[signByKey]) {
    rows.push(["Sign by", fmtDate(form[signByKey])]);
  }
  if (fees) rows.push([docTab === "post" ? "Total fee" : "Upfront fee", fmt(fees.upfront)]);
  if (fees?.contingent) rows.push(["Contingent, on award", fmt(fees.contingent)]);
  if (form.expirationDate && docTab !== "addendum") {
    rows.push(["Offer expires", fmtDate(form.expirationDate)]);
  }

  return (
    <div className="wz-fees">
      {rows.map(([k, v]) => (
        <div key={k} className="wz-fee-line">
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
      {fees && (
        <div className="wz-fee-line wz-fee-total">
          <span>Total</span>
          <b>{fmt(fees.total)}</b>
        </div>
      )}
    </div>
  );
}

/* ── shell ───────────────────────────────────────────────────────────── */

/* Steps for a document type, including the picker that leads them. */
export function stepsOf(docTab) {
  return [{ id: "doc", title: "Engagement Type" }, ...stepsFor(docTab)];
}

export default function Wizard({
  docTab,
  onDocTab,
  form,
  setF,
  step,
  onStep,
  onBack,
  onDownload,
  downloadLabel = "Download PDF",
  downloadDisabled,
  downloadHint,
  onReview,
  onEmail,
  onConvertToGw,
  onConvertView,
  convertViewLabel,
  onSave,
  onSplit,
  splitNote,
  onDismissSplitNote,
  saveLabel = "Save Letter",
  savedNote,
}) {

  // Fees scale on applications, not sites: one location applying under two
  // programs is two applications. App.jsx prices the letter the same way.
  const numLocs = applicationCount(form.programs, form.locations);
  const fees = calcFees(form.engagementModel, form.pricingTier, numLocs, form.optPostAwardScope,
    form.postAwardFee, form.customFee, form.earlySigningAmount, form.customContingencyFee,
    form.contingentDiscount);
  const inhFees = calcFees(form.inhEngagementModel, form.inhPricingTier, numLocs, form.inhOptPostAwardScope,
    form.inhPostAwardFee, form.inhCustomFee, form.inhEarlySigningAmount, form.inhCustomContingencyFee,
    form.inhContingentDiscount);

  // Which fee set this document actually quotes. Award Implementation and the
  // grant-writer agreement carry a single flat figure rather than a tiered one.
  const active = docTab === "inh" || (docTab === "proposal" && form.proposalFeeModel === "inh") ? inhFees : fees;
  const flat = (raw) => {
    const n = parseFloat(String(raw).replace(/,/g, "")) || 0;
    return { upfront: n, baseUpfront: n, discount: 0, contingent: null, postAward: null, total: n };
  };
  // An addendum amends an agreement already priced; it carries no fee of its
  // own, so the bar must not advertise the pre-award figure it would inherit.
  const summary = docTab === "addendum" ? null
    : docTab === "post" ? flat(form.postFee)
      : docTab === "gw" ? flat(form.gwProfFee)
        : active;

  /*
   * Award Implementation is priced at 5% of total maximum award. This lives in
   * the shell rather than the Fees step so the bar is right from step one —
   * mounted-only auto-fill left it showing a stale default until the rep
   * happened to walk that far.
   *
   * loadLetter() sets postFeeTouched, so a saved letter is never repriced.
   */
  const postSuggested = Math.round(totalMaxAward(form.postPrograms, form.locations) * 0.05);
  useEffect(() => {
    if (docTab !== "post" || form.postFeeTouched || postSuggested <= 0) return;
    const current = parseFloat(String(form.postFee).replace(/,/g, "")) || 0;
    if (current !== postSuggested) setF("postFee", postSuggested.toLocaleString());
  }, [docTab, postSuggested, form.postFeeTouched]);

  /*
   * Choosing the Early Signing Discount should arrive with a usable deadline
   * rather than a hardcoded date that has already passed. Two weeks out, and
   * only when the field is empty, so a rep's own date and dates on saved
   * letters are never overwritten.
   */
  const signByKey = docTab === "inh" ? "inhEarlySigningDate" : "earlySigningDate";
  const tierKey = docTab === "inh" ? "inhPricingTier" : "pricingTier";
  useEffect(() => {
    if (form[tierKey] === "discounted" && !form[signByKey]) setF(signByKey, isoDatePlus(14));
  }, [form[tierKey], form[signByKey]]);

  const steps = stepsOf(docTab);
  const clamped = Math.min(step, steps.length - 1);
  const current = steps[clamped];
  const last = clamped === steps.length - 1;

  /*
   * Award Implementation and contingent letters carry one application each, so
   * a second one is not an error to refuse but work to divide — see splitPlan()
   * in App.jsx. The count is read from the document's OWN program list: an
   * Award Implementation letter keeps its programs under postPrograms, and
   * reading form.programs there would police the wrong list.
   */
  const scopedPrograms = form[programsKeyFor(docTab)];
  const scopedApps = applicationCount(scopedPrograms, form.locations);
  const model = docTab === "inh" ? form.inhEngagementModel : form.engagementModel;
  const mustSplit = oneApplicationPerLetter(docTab, model) && scopedApps > 1;

  const ctx = { form, setF, fees: active, inhFees, numLocs, docTab, mustSplit, scopedApps, onSplit };

  // Changing document type re-shapes the flow, so restart from the step after
  // the picker rather than stranding the rep on an index that no longer exists.
  const changeDocTab = (t) => {
    onDocTab(t);
    onStep(0);
  };

  return (
    <div className="wz-form">
        {splitNote && (
          <div style={{ background: "var(--ok-bg)", border: "1px solid var(--ok-fg)", borderRadius: 10,
                        padding: "11px 13px", margin: "0 0 12px", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ fontSize: 12.5, color: "var(--ok-fg)", lineHeight: 1.5, flex: 1 }}>{splitNote}</div>
            <button type="button" onClick={onDismissSplitNote} aria-label="Dismiss"
              style={{ background: "none", border: "none", color: "var(--ok-fg)", fontSize: 15,
                       cursor: "pointer", lineHeight: 1, padding: 0 }}>&times;</button>
          </div>
        )}
        {onBack && (
          <button type="button" className="wz-back" onClick={onBack}>
            &#8592; Dashboard
          </button>
        )}
        <div className="wz-card">
          <div className="wz-steps">
            {steps.map((s, n) => (
              <span key={s.id} className="wz-seg"
                data-s={n < clamped ? "done" : n === clamped ? "now" : "next"} />
            ))}
          </div>
          <div className="wz-caption">
            Step {clamped + 1} of {steps.length} — {current.title}
          </div>
        </div>

        <div className="wz-card">
          <h2 className="wz-h">{current.title}</h2>
          {current.id === "doc" && <DocTypeStep docTab={docTab} onDocTab={changeDocTab} />}
          {current.id === "review" && (
            <>
              <ReviewStep form={form} docTab={docTab} fees={summary} numLocs={numLocs} signByKey={signByKey} tierKey={tierKey} />
              {(onReview || onEmail || onConvertToGw || onConvertView) && (
                <div className="wz-chips">
                  {onConvertView && (
                    <button type="button" className="wz-btn" onClick={onConvertView}>
                      {convertViewLabel}
                    </button>
                  )}
                  {onConvertToGw && (
                    <button type="button" className="wz-btn" onClick={onConvertToGw}>
                      Create 3rd Party Grant Writer agreement
                    </button>
                  )}
                  {onReview && (
                    <button type="button" className="wz-btn" onClick={onReview}>
                      Review &amp; Edit Letter
                    </button>
                  )}
                  {onEmail && (
                    <button type="button" className="wz-btn" onClick={onEmail}>
                      Email to Grant Writer
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {current.render && current.render(ctx)}
        </div>

        <div className="wz-bar">
          <div className="wz-bar-fig">
            {summary ? (
              <>
                <div className="wz-label" style={{ marginBottom: 2 }}>
                  {docTab === "post" ? "Total fee" : "Upfront fee"}
                </div>
                <div className="wz-bar-amt">{fmt(summary.upfront)}</div>
                {summary.contingent ? (
                  <div className="wz-bar-note">+ {fmt(summary.contingent)} on award</div>
                ) : null}
              </>
            ) : (
              <div className="wz-bar-note">Amends an agreement already priced.</div>
            )}
          </div>

          <button type="button" className="wz-btn" disabled={clamped === 0} onClick={() => onStep(clamped - 1)}>
            Back
          </button>

          {last ? (
            <>
              {onSave && (
                <button type="button" className="wz-btn" onClick={onSave}>
                  {saveLabel}
                </button>
              )}
              <button
                type="button"
                className="wz-btn wz-btn-primary"
                onClick={onDownload}
                disabled={downloadDisabled}
                title={downloadDisabled ? downloadHint : ""}
              >
                {downloadLabel}
              </button>
            </>
          ) : (
            <button type="button" className="wz-btn wz-btn-primary" onClick={() => onStep(clamped + 1)}>
              Next →
            </button>
          )}
        </div>
        {savedNote && <div className="wz-caption">{savedNote}</div>}
    </div>
  );
}
