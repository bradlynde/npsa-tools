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
import { fmt, calcFees, totalMaxAward } from "./engine.js";
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

function ReviewStep({ form, docTab, fees, numLocs }) {
  const label = DOC_TYPES.find((d) => d.tab === docTab || (d.tabs || []).includes(docTab))?.label;
  const variant = docTab === "inh" ? "In-House" : docTab === "pre" ? "Third Party" : null;

  // Each document stores its party under its own key. Falling back across them
  // would show the pre-award client on a grant-writer agreement addressed to
  // someone else entirely.
  const party = docTab === "gw"
    ? ["Recipient", form.gwRecipientName]
    : docTab === "addendum"
      ? ["Client", form.addendumClientName]
      : ["Client", form.clientName];

  const rows = [
    [party[0], party[1] || "—"],
    ["Document", variant ? `${label} · ${variant}` : label],
  ];
  // Documents without locations (grant writer, addendum) shouldn't claim one.
  if (docTab !== "gw" && docTab !== "addendum") rows.push(["Locations", numLocs]);
  if (fees) rows.push([docTab === "post" ? "Total fee" : "Upfront fee", fmt(fees.upfront)]);
  if (fees?.contingent) rows.push(["Contingent, on award", fmt(fees.contingent)]);

  return (
    <>
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
    </>
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
  onSave,
  saveLabel = "Save Letter",
  savedNote,
}) {

  const numLocs = Math.max((form.locations || []).length, 1);
  const fees = calcFees(form.engagementModel, form.pricingTier, numLocs, form.optPostAwardScope,
    form.postAwardFee, form.customFee, form.earlySigningAmount, form.customContingencyFee);
  const inhFees = calcFees(form.inhEngagementModel, form.inhPricingTier, numLocs, form.inhOptPostAwardScope,
    form.inhPostAwardFee, form.inhCustomFee, form.inhEarlySigningAmount, form.inhCustomContingencyFee);

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

  const steps = stepsOf(docTab);
  const clamped = Math.min(step, steps.length - 1);
  const current = steps[clamped];
  const last = clamped === steps.length - 1;

  const ctx = { form, setF, fees: active, inhFees, numLocs, docTab };

  // Changing document type re-shapes the flow, so restart from the step after
  // the picker rather than stranding the rep on an index that no longer exists.
  const changeDocTab = (t) => {
    onDocTab(t);
    onStep(0);
  };

  return (
    <div className="wz-form">
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
            <ReviewStep form={form} docTab={docTab} fees={summary} numLocs={numLocs} />
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
              <button type="button" className="wz-btn wz-btn-primary" onClick={onDownload}>
                Download PDF
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
