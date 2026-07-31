/*
 * The engagement-letter wizard shell.
 *
 * Owns navigation, progress and the fee bar; the steps themselves come from
 * steps.jsx and the controls from ui.jsx. The letter preview is passed in as a
 * node — this component never renders letter text, so client-facing wording
 * stays exactly where it was.
 *
 * On a phone the preview is hidden until the review step (see wizard.css),
 * which is why the review step carries it inline as well.
 */

import { useState } from "react";
import { fmt, calcFees } from "./engine.js";
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

function ReviewStep({ form, docTab, fees, numLocs, preview }) {
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
      {/* Carried inline so the letter is reviewable on a phone, where the
          side-by-side preview column is hidden. */}
      {preview && <div className="wz-review-doc">{preview}</div>}
    </>
  );
}

/* ── shell ───────────────────────────────────────────────────────────── */

export default function Wizard({
  docTab,
  onDocTab,
  form,
  setF,
  preview,
  onDownload,
  onSave,
  saveLabel = "Save Letter",
}) {
  const [i, setI] = useState(0);

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

  const steps = [{ id: "doc", title: "Document" }, ...stepsFor(docTab)];
  const clamped = Math.min(i, steps.length - 1);
  const step = steps[clamped];
  const last = clamped === steps.length - 1;

  const ctx = { form, setF, fees: active, inhFees, numLocs, docTab };

  // Changing document type re-shapes the flow, so restart from the step after
  // the picker rather than stranding the rep on an index that no longer exists.
  const changeDocTab = (t) => {
    onDocTab(t);
    setI(0);
  };

  return (
    <div className={`wz${last ? " wz-review" : ""}`}>
      <div className="wz-form">
        <div className="wz-card">
          <div className="wz-steps">
            {steps.map((s, n) => (
              <span key={s.id} className="wz-seg"
                data-s={n < clamped ? "done" : n === clamped ? "now" : "next"} />
            ))}
          </div>
          <div className="wz-caption">
            Step {clamped + 1} of {steps.length} — {step.title}
          </div>
        </div>

        <div className="wz-card">
          <h2 className="wz-h">{step.title}</h2>
          {step.id === "doc" && <DocTypeStep docTab={docTab} onDocTab={changeDocTab} />}
          {step.id === "review" && (
            <ReviewStep form={form} docTab={docTab} fees={summary} numLocs={numLocs} preview={preview} />
          )}
          {step.render && step.render(ctx)}
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

          <button type="button" className="wz-btn" disabled={clamped === 0} onClick={() => setI(clamped - 1)}>
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
            <button type="button" className="wz-btn wz-btn-primary" onClick={() => setI(clamped + 1)}>
              Next →
            </button>
          )}
        </div>
      </div>

      <div className="wz-preview">{preview}</div>
    </div>
  );
}
