/*
 * What each document type asks for, and in what order.
 *
 * A common spine — client, scope, fees, terms, review — with steps a document
 * type doesn't need simply left out, so this is one wizard rather than six.
 * Proposal and Addendum land on four steps; the rest on five, plus the
 * document-type step in front.
 *
 * Every field the old sidebar collected still has a home. The ones that are
 * rarely touched sit behind <Advanced>, next to the control they belong to,
 * rather than in a junk-drawer step at the end.
 */

import { fmt, totalMaxAward } from "./engine.js";
import {
  Field, Text, Check, Chips, RadioCards,
  ProgramsPicker, FeeCalculator, InstallmentsEditor, LocationsEditor,
} from "./ui.jsx";

/* Collapsed disclosure for the long tail of options. */
export function Advanced({ label = "Advanced", children }) {
  return (
    <details className="wz-adv">
      <summary>{label}</summary>
      <div className="wz-adv-body">{children}</div>
    </details>
  );
}

/* ── shared step pieces ──────────────────────────────────────────────── */

const clientStep = (extra) => ({
  id: "client",
  title: "Client",
  render: (c) => (
    <>
      <Text label="Organization Name" value={c.form.clientName} placeholder="e.g. First Baptist Church"
        onChange={(v) => c.setF("clientName", v)} />
      <Text label="Primary Contact Name" value={c.form.contactName} placeholder="e.g. Jane Smith"
        onChange={(v) => c.setF("contactName", v)} />
      <Text label="Contact Title" value={c.form.contactTitle} placeholder="Pastor, Executive Director"
        onChange={(v) => c.setF("contactTitle", v)} />
      <Text label="Email" value={c.form.contactEmail} placeholder="e.g. jane@organization.org"
        onChange={(v) => c.setF("contactEmail", v)} />
      <Text label="Phone" value={c.form.contactPhone} placeholder="(xxx) xxx-xxxx"
        onChange={(v) => c.setF("contactPhone", v)} />
      {extra && extra(c)}
    </>
  ),
});

const scopeStep = ({ programsKey = "programs", yearLabel = "Grant Year", locations = true, extra } = {}) => ({
  id: "scope",
  title: "Scope",
  render: (c) => (
    <>
      {extra && extra(c)}
      <Field label="Programs">
        <ProgramsPicker
          items={c.form[programsKey]}
          locations={locations ? c.form.locations : null}
          yearLabel={yearLabel}
          newYear={() => c.form.grantYear || "2026"}
          onChange={(v) => c.setF(programsKey, v)}
        />
      </Field>
      {locations && (
        <Field label="Locations" hint={`${c.numLocs} location${c.numLocs === 1 ? "" : "s"} · max award ${fmt(totalMaxAward(c.form[programsKey], c.form.locations))} total`}>
          <LocationsEditor
            locations={c.form.locations}
            programs={c.form[programsKey]}
            onChange={(v) => c.setF("locations", v)}
          />
        </Field>
      )}
    </>
  ),
});

/* Signer, dates and the custom clause — shared by every document that has them. */
const signingBlock = (c, { clauseKey, expiration = true }) => (
  <>
    <Text label="NPSA Signer" value={c.form.npsaSignerName} placeholder="Brad Lynde"
      onChange={(v) => c.setF("npsaSignerName", v)} />
    <Text label="Signing Date" type="date" value={c.form.npsaSigningDate}
      onChange={(v) => c.setF("npsaSigningDate", v)} />
    {expiration && (
      <Text label="Offer Expiration Date" type="date" value={c.form.expirationDate}
        onChange={(v) => c.setF("expirationDate", v)} />
    )}
    <Advanced label="Custom clause">
      <Field label="Additional Clause" hint="Appended to the letter body.">
        <textarea className="wz-input" rows={4} value={c.form[clauseKey] || ""}
          onChange={(e) => c.setF(clauseKey, e.target.value)} />
      </Field>
    </Advanced>
  </>
);

/* Terms for the two pre-award variants, which differ only by field prefix. */
const preTermsStep = (prefix) => ({
  id: "terms",
  title: "Terms",
  render: (c) => (
    <>
      <InstallmentsEditor form={c.form} setF={c.setF} prefix={prefix} upfront={c.fees.upfront} />
      <Check label="Short-notice engagement" checked={c.form[prefix ? "inhOptShortNotice" : "optShortNotice"]}
        onChange={(v) => c.setF(prefix ? "inhOptShortNotice" : "optShortNotice", v)} />
      <Check label="Reference the NOFO" checked={c.form[prefix ? "inhOptNofo" : "optNofo"]}
        onChange={(v) => c.setF(prefix ? "inhOptNofo" : "optNofo", v)} />
      {signingBlock(c, { clauseKey: prefix ? "inhCustomClause" : "customClause" })}
    </>
  ),
});

const reviewStep = { id: "review", title: "Review" };

/* ── Award Implementation fee ────────────────────────────────────────── */

/**
 * Priced at 5% of the engagement's total maximum award, auto-filled and
 * editable. Once a rep types their own figure it is left alone — otherwise
 * adding a location would silently overwrite a negotiated number.
 */
function PostFee({ form, setF }) {
  const max = totalMaxAward(form.postPrograms, form.locations);
  const suggested = Math.round(max * 0.05);
  const touched = !!form.postFeeTouched;

  const apply = () => {
    setF("postFee", suggested.toLocaleString());
    setF("postFeeTouched", false);
  };

  const pct = [form.postPmt1, form.postPmt2, form.postPmt3].map((p) => parseFloat(p) || 0);
  const fee = parseFloat(String(form.postFee).replace(/,/g, "")) || 0;
  const sum = pct.reduce((a, b) => a + b, 0);

  return (
    <>
      <Text
        label="Total Fixed Fee ($)"
        hint={max > 0
          ? `5% of ${fmt(max)} total maximum award is ${fmt(suggested)}.`
          : "Add locations and programs to compute the 5% figure."}
        value={form.postFee}
        placeholder="10,000"
        onChange={(v) => { setF("postFee", v); setF("postFeeTouched", true); }}
      />
      {max > 0 && touched && fee !== suggested && (
        <button type="button" className="wz-chip wz-chip-add" onClick={apply}>
          Use {fmt(suggested)}
        </button>
      )}

      <Text label="Effective Date" type="date" value={form.postEffectiveDate}
        onChange={(v) => setF("postEffectiveDate", v)} />

      <Field label="Payment Schedule" hint={sum !== 100 ? `Percentages total ${sum}%, not 100%.` : undefined}>
        {[1, 2, 3].map((n) => (
          <Text
            key={n}
            label={`Payment ${n} (%) — ${fmt(Math.round((fee * pct[n - 1]) / 100))}`}
            value={form[`postPmt${n}`]}
            onChange={(v) => setF(`postPmt${n}`, v)}
          />
        ))}
      </Field>
    </>
  );
}

/* ── the map ─────────────────────────────────────────────────────────── */

const PRE_AWARD = (prefix) => [
  clientStep(),
  scopeStep(),
  {
    id: "fees",
    title: "Fees",
    render: (c) => (
      <FeeCalculator
        form={c.form}
        setF={c.setF}
        prefix={prefix}
        fees={c.fees}
        numLocs={c.numLocs}
      />
    ),
  },
  preTermsStep(prefix),
  reviewStep,
];

export const STEPS = {
  inh: PRE_AWARD("inh"),
  pre: PRE_AWARD(""),

  post: [
    clientStep(),
    scopeStep({ programsKey: "postPrograms", yearLabel: "Award Year" }),
    { id: "fees", title: "Fees", render: (c) => <PostFee form={c.form} setF={c.setF} /> },
    {
      id: "terms",
      title: "Terms",
      render: (c) => (
        <>
          <Field label="Reimbursement">
            <RadioCards
              name="postReimbursement"
              value={c.form.postReimbursementOption}
              onChange={(v) => c.setF("postReimbursementOption", v)}
              options={[
                { value: "not-reimbursable", label: "Not reimbursable", description: "Fees are the client's own responsibility." },
                { value: "reimbursable", label: "Reimbursable from grant funds", description: "Where the program permits it." },
              ]}
            />
          </Field>
          {signingBlock(c, { clauseKey: "postCustomClause" })}
        </>
      ),
    },
    reviewStep,
  ],

  proposal: [
    clientStep(),
    scopeStep({
      extra: (c) => (
        <Field
          label="Service Model"
          hint={c.form.proposalServiceModel === "full"
            ? "Covers the whole grant lifecycle, including Award Implementation."
            : "Covers the Pre-Award and Compliance Periods. Implementation is separate."}
        >
          <Chips
            value={c.form.proposalServiceModel || "inhouse"}
            onChange={(v) => c.setF("proposalServiceModel", v)}
            options={[
              { value: "inhouse", label: "Pre-Award & Compliance" },
              { value: "full", label: "Full-Service" },
            ]}
          />
        </Field>
      ),
    }),
    {
      id: "fees",
      title: "Fees",
      render: (c) => {
        const inh = c.form.proposalFeeModel === "inh";
        return (
          <>
            <Field
              label="Grant Writing Model"
              hint={inh
                ? "NPSA writes and submits the application."
                : "An independent grant writer, engaged by CLIENT, writes and submits it."}
            >
              <Chips
                value={c.form.proposalFeeModel || "inh"}
                onChange={(v) => c.setF("proposalFeeModel", v)}
                options={[
                  { value: "inh", label: "In-House Grant Writer" },
                  { value: "pre", label: "Third-Party Grant Writer" },
                ]}
              />
            </Field>
            <FeeCalculator
              form={c.form}
              setF={c.setF}
              prefix={inh ? "inh" : ""}
              fees={inh ? c.inhFees : c.fees}
              numLocs={c.numLocs}
              showPostAward={false}
            />
          </>
        );
      },
    },
    reviewStep,
  ],

  gw: [
    {
      id: "recipient",
      title: "Grant Writer",
      render: (c) => (
        <>
          <Text label="Grant Writer / Recipient" value={c.form.gwRecipientName}
            onChange={(v) => c.setF("gwRecipientName", v)} />
          <Text label="Grant Writer Organization" value={c.form.gwOrgName}
            placeholder="e.g. Cardinal Grants LLC"
            onChange={(v) => c.setF("gwOrgName", v)} />
          <Text label="Grant Writer Email" type="email" value={c.form.gwRecipientEmail}
            placeholder="e.g. writer@firm.com"
            onChange={(v) => c.setF("gwRecipientEmail", v)} />
          <Text label="Agreement Date" type="date" value={c.form.gwDate}
            onChange={(v) => c.setF("gwDate", v)} />
          <Field label="Copy To" hint="Additional recipients listed on the agreement.">
            {(c.form.gwCcContacts || []).map((cc, i) => (
              <div key={i} className="wz-row">
                <div className="wz-row-head">
                  <span className="wz-row-t">Contact {i + 1}</span>
                  <button type="button" className="wz-x" aria-label={`Remove contact ${i + 1}`}
                    onClick={() => c.setF("gwCcContacts", c.form.gwCcContacts.filter((_, n) => n !== i))}>×</button>
                </div>
                {["name", "title", "email"].map((f) => (
                  <Text key={f} label={f[0].toUpperCase() + f.slice(1)} value={cc[f]}
                    onChange={(v) => c.setF("gwCcContacts",
                      c.form.gwCcContacts.map((x, n) => (n === i ? { ...x, [f]: v } : x)))} />
                ))}
              </div>
            ))}
            <div className="wz-chips" style={{ marginTop: 10 }}>
              <button type="button" className="wz-chip wz-chip-add"
                onClick={() => c.setF("gwCcContacts", [...(c.form.gwCcContacts || []), { name: "", title: "", email: "" }])}>
                + Add contact
              </button>
            </div>
          </Field>
        </>
      ),
    },
    clientStep(),
    scopeStep({ programsKey: "gwPrograms" }),
    {
      id: "fees",
      title: "Fees",
      render: (c) => (
        <>
          <Text label="Professional Fee ($)" value={c.form.gwProfFee} placeholder="e.g. 3,500"
            onChange={(v) => c.setF("gwProfFee", v)} />
          <Check label="Include the performance guarantee" checked={c.form.gwGuar1}
            onChange={(v) => c.setF("gwGuar1", v)} />
          <Text label="Submission Deadline" value={c.form.gwGuar4Deadline}
            onChange={(v) => c.setF("gwGuar4Deadline", v)} />
        </>
      ),
    },
    {
      id: "terms",
      title: "Terms",
      render: (c) => (
        <>
          <Text label="NPSA Consultant" value={c.form.npsa1Name}
            onChange={(v) => c.setF("npsa1Name", v)} />
          <Field label="Notes">
            <textarea className="wz-input" rows={4} value={c.form.gwNotes || ""}
              onChange={(e) => c.setF("gwNotes", e.target.value)} />
          </Field>
        </>
      ),
    },
    reviewStep,
  ],

  addendum: [
    {
      id: "client",
      title: "Client",
      render: (c) => (
        <>
          <Text label="Organization Name" value={c.form.addendumClientName}
            onChange={(v) => c.setF("addendumClientName", v)} />
          <Text label="Original Agreement Date" type="date" value={c.form.addendumOriginalDate}
            onChange={(v) => c.setF("addendumOriginalDate", v)} />
        </>
      ),
    },
    scopeStep({ programsKey: "addendumPrograms", locations: false }),
    {
      id: "terms",
      title: "Terms",
      // An addendum carries no expiration of its own; it inherits the original.
      render: (c) => signingBlock(c, { clauseKey: "customClause", expiration: false }),
    },
    reviewStep,
  ],
};

export function stepsFor(docTab) {
  return STEPS[docTab] || STEPS.inh;
}
