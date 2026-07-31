/*
 * Shared controls for the engagement-letter wizard.
 *
 * The sidebar these replace wrote the programs picker five times, the fee
 * calculator three, and the installment editor twice. Behaviour and form keys
 * are ported unchanged — only the markup is shared and the styling is new.
 *
 * Nothing here holds state: `form` is the single source of truth and every
 * control writes through setF, exactly as the sidebar did.
 */

import { PROGRAMS, TIER_LABELS, fmt } from "./engine.js";

/* ── small primitives ────────────────────────────────────────────────── */

export function Field({ label, hint, children }) {
  return (
    <div className="wz-field">
      {label && <label className="wz-label">{label}</label>}
      {children}
      {hint && <div className="wz-hint">{hint}</div>}
    </div>
  );
}

export function Text({ label, hint, value, onChange, placeholder, type = "text", readOnly }) {
  return (
    <Field label={label} hint={hint}>
      <input
        className="wz-input"
        type={type}
        value={value ?? ""}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function Check({ label, checked, onChange }) {
  return (
    <label className="wz-check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Chips({ options, value, onChange }) {
  return (
    <div className="wz-chips">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="wz-chip"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RadioCards({ options, value, onChange, name }) {
  return (
    <div>
      {options.map((o) => (
        <label key={o.value} className="wz-radio" data-on={value === o.value ? "1" : "0"}>
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span>
            <span className="wz-radio-t">{o.label}</span>
            {o.description && <span className="wz-radio-d">{o.description}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/* ── programs ────────────────────────────────────────────────────────── */

/**
 * Grant/award programs with a per-program year.
 *
 * Replaces five near-identical copies that varied only in which form key they
 * wrote, what the year field was called, and whether they showed the max award
 * and the application count.
 */
export function ProgramsPicker({
  items,
  onChange,
  yearLabel = "Grant Year",
  newYear = () => "2026",
  showMaxAward = true,
  locations,
}) {
  const list = items || [];
  const set = (i, patch) => onChange(list.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  return (
    <div>
      {list.map((pg, i) => {
        const cfg = PROGRAMS[pg.key] || PROGRAMS.federal;
        // Applications == how many locations opted into this program. Only the
        // document types that collect locations can show it.
        const apps = locations
          ? locations.filter((l) => (l.programs || ["federal"]).includes(pg.key)).length
          : null;
        return (
          <div key={i} className="wz-row">
            <div className="wz-row-head">
              <span className="wz-row-t">{cfg.label}</span>
              {list.length > 1 && (
                <button
                  type="button"
                  className="wz-x"
                  aria-label={`Remove ${cfg.label}`}
                  onClick={() => onChange(list.filter((_, n) => n !== i))}
                >
                  ×
                </button>
              )}
            </div>
            <Text
              label={yearLabel}
              value={pg.year || "2026"}
              placeholder="2026"
              onChange={(v) => set(i, { year: v })}
            />
            {showMaxAward && (
              <div className="wz-hint">
                Max award <b style={{ color: "var(--olive)" }}>${cfg.maxAward}</b>
                {apps !== null && <> · {apps} application{apps === 1 ? "" : "s"}</>}
              </div>
            )}
          </div>
        );
      })}

      <div className="wz-chips" style={{ marginTop: 10 }}>
        {Object.entries(PROGRAMS)
          .filter(([k]) => !list.some((p) => p.key === k))
          .map(([k, cfg]) => (
            <button
              key={k}
              type="button"
              className="wz-chip wz-chip-add"
              onClick={() => onChange([...list, { key: k, year: newYear() }])}
            >
              + {cfg.label}
            </button>
          ))}
      </div>
    </div>
  );
}

/* ── fees ────────────────────────────────────────────────────────────── */

// Prefixed field names: the in-house variant stores everything under inh*.
const key = (prefix, name) =>
  prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;

/**
 * Engagement model, pricing tier, early signing and the live fee summary.
 *
 * One control decides the tier. TIER_LABELS.discounted *is* "Early Signing
 * Discount", so a separate early-signing toggle beside the tier would apply
 * the discount twice and quote the client wrong.
 *
 * Max Discount is deliberately absent. Undiscounted plus a discount reaches the
 * same figure while attaching an execution deadline to it, which is what the
 * pricing sheet tells reps to do.
 */
export function FeeCalculator({ form, setF, prefix = "", fees, numLocs, showPostAward = true }) {
  const k = (n) => key(prefix, n);
  const g = (n) => form[k(n)];
  const modelKey = k("engagementModel");
  const pc = prefix ? "inh-partial-contingency" : "partial-contingency";
  const preOnly = prefix ? "inh-pre-only" : "pre-only";

  const isPartial = form[modelKey] === pc;
  const tier = g("pricingTier");
  const discounted = tier === "discounted";

  // On partial contingency the discounted fees come straight from the pricing
  // table, so the amount field drives nothing — show what was actually applied.
  const amountDrivesPrice = !isPartial;

  return (
    <div>
      <RadioCards
        name={`${prefix || "pre"}-model`}
        value={form[modelKey]}
        onChange={(v) => setF(modelKey, v)}
        options={[
          {
            value: preOnly,
            label: "Pre-Award Only",
            description: "Flat fee due at signing, with a refundable window.",
          },
          {
            value: pc,
            label: "Pre-Award + Partial Contingency",
            description: "Lower upfront fee, with the balance due on award.",
          },
        ]}
      />

      <Field label="Pricing Tier">
        <select
          className="wz-select"
          value={tier}
          onChange={(e) => setF(k("pricingTier"), e.target.value)}
        >
          {Object.entries(TIER_LABELS)
            .filter(([t]) => t !== "max")
            .map(([t, label]) => (
              <option key={t} value={t}>
                {label}
              </option>
            ))}
        </select>
      </Field>

      {tier === "custom" && (
        <Text
          label="Custom Fee Amount ($)"
          value={g("customFee")}
          placeholder="e.g. 5,000"
          onChange={(v) => setF(k("customFee"), v)}
        />
      )}

      {isPartial && (
        <Text
          label="Contingency Fee Override ($)"
          hint="Leave blank to use the pricing table."
          value={g("customContingencyFee")}
          placeholder="e.g. 3,500"
          onChange={(v) => setF(k("customContingencyFee"), v)}
        />
      )}

      {discounted && (
        <>
          <Text
            label="Sign-By Date"
            hint="The client must execute by this date to hold the discount."
            value={g("earlySigningDate")}
            placeholder="March 15, 2026"
            onChange={(v) => setF(k("earlySigningDate"), v)}
          />
          {amountDrivesPrice ? (
            <Text
              label="Discount Amount ($ per location)"
              value={g("earlySigningAmount")}
              placeholder="1,500"
              onChange={(v) => setF(k("earlySigningAmount"), v)}
            />
          ) : (
            <Text
              label="Discount Applied"
              hint="Set by the pricing table for partial contingency."
              value={fmt(fees.discount)}
              readOnly
            />
          )}
        </>
      )}

      {showPostAward && (
        <>
          <Check
            label="Include Compliance Period services"
            checked={g("optPostAwardScope")}
            onChange={(v) => setF(k("optPostAwardScope"), v)}
          />
          {g("optPostAwardScope") && (
            <Text
              label="Compliance Consulting Fee ($ per location)"
              value={g("postAwardFee")}
              placeholder="2,500"
              onChange={(v) => setF(k("postAwardFee"), v)}
            />
          )}
        </>
      )}

      <FeeSummary fees={fees} numLocs={numLocs} discounted={discounted} />
    </div>
  );
}

export function FeeSummary({ fees, numLocs, discounted }) {
  return (
    <div className="wz-fees">
      <div className="wz-fee-line">
        <span>Upfront fee</span>
        <b>
          {discounted && fees.discount > 0 && (
            <span className="wz-was">{fmt(fees.baseUpfront)}</span>
          )}
          {fmt(fees.upfront)}
        </b>
      </div>

      {discounted && fees.discount > 0 && (
        <div className="wz-fee-line">
          <span>Early signing discount</span>
          <b>−{fmt(fees.discount)}</b>
        </div>
      )}

      {fees.contingent !== null && (
        <div className="wz-fee-line">
          <span>Contingent fee, on award</span>
          <b>{fmt(fees.contingent)}</b>
        </div>
      )}

      {fees.postAward !== null && fees.postAward > 0 && (
        <div className="wz-fee-line">
          <span>Compliance consulting{numLocs > 1 ? ` ×${numLocs}` : ""}</span>
          <b>{fmt(fees.postAward)}</b>
        </div>
      )}

      <div className="wz-fee-line wz-fee-total">
        <span>Total</span>
        <b>{fmt(fees.total)}</b>
      </div>

      {discounted && fees.discount > 0 && (
        <div className="wz-save">
          Discounted fee {fmt(fees.upfront)} — saves {fmt(fees.discount)}
        </div>
      )}
    </div>
  );
}

/* ── installments ────────────────────────────────────────────────────── */

/**
 * Optional payment schedule for the upfront fee. Percentages are free text
 * because they are interpolated into letter wording, not just arithmetic.
 */
export function InstallmentsEditor({ form, setF, prefix = "", upfront }) {
  const k = (n) => key(prefix, n);
  const on = form[k("installments")];
  const count = parseInt(form[k("installmentCount")]) || 2;

  const rows = [1, 2, 3].slice(0, count).map((n) => ({
    n,
    pct: form[k(`installment${n}Pct`)],
    label: form[k(`installment${n}Label`)],
  }));

  const total = rows.reduce((s, r) => s + (parseFloat(r.pct) || 0), 0);

  return (
    <div>
      <Check
        label="Split the upfront fee into installments"
        checked={on}
        onChange={(v) => setF(k("installments"), v)}
      />

      {on && (
        <>
          <Field label="Number of Payments">
            <Chips
              value={count}
              onChange={(v) => setF(k("installmentCount"), v)}
              options={[
                { value: 2, label: "2 payments" },
                { value: 3, label: "3 payments" },
              ]}
            />
          </Field>

          {rows.map((r) => (
            <div key={r.n} className="wz-row">
              <div className="wz-row-head">
                <span className="wz-row-t">Payment {r.n}</span>
                <span className="wz-hint" style={{ marginTop: 0 }}>
                  {fmt(Math.round((upfront * (parseFloat(r.pct) || 0)) / 100))}
                </span>
              </div>
              <Text
                label="Percent"
                value={r.pct}
                placeholder="40"
                onChange={(v) => setF(k(`installment${r.n}Pct`), v)}
              />
              <Text
                label="Due When"
                value={r.label}
                placeholder="upon execution"
                onChange={(v) => setF(k(`installment${r.n}Label`), v)}
              />
            </div>
          ))}

          {Math.round(total) !== 100 && (
            <div className="wz-hint" style={{ color: "var(--warn-fg)" }}>
              Percentages total {total}%, not 100%.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── locations ───────────────────────────────────────────────────────── */

/**
 * Sites covered by the engagement. Each location opts into one or more
 * programs, which is what drives the application count and the fee tier.
 */
export function LocationsEditor({ locations, onChange, programs }) {
  const list = locations || [];
  const set = (i, patch) => onChange(list.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const chosen = (programs || []).map((p) => p.key);

  return (
    <div>
      {list.map((loc, i) => (
        <div key={i} className="wz-row">
          <div className="wz-row-head">
            <span className="wz-row-t">Location {i + 1}{i === 0 ? " · primary" : ""}</span>
            {i > 0 && (
              <button
                type="button"
                className="wz-x"
                aria-label={`Remove location ${i + 1}`}
                onClick={() => onChange(list.filter((_, n) => n !== i))}
              >
                ×
              </button>
            )}
          </div>

          <Text label="Site Name" value={loc.name} placeholder="optional" onChange={(v) => set(i, { name: v })} />
          <Text label="Street Address" value={loc.address} onChange={(v) => set(i, { address: v })} />
          <Text label="City" value={loc.city} onChange={(v) => set(i, { city: v })} />
          <Text label="State" value={loc.state} onChange={(v) => set(i, { state: v })} />
          <Text label="ZIP" value={loc.zip} onChange={(v) => set(i, { zip: v })} />

          {chosen.length > 1 && (
            <Field label="Applies To">
              <div className="wz-chips">
                {chosen.map((pk) => {
                  const on = (loc.programs || ["federal"]).includes(pk);
                  return (
                    <button
                      key={pk}
                      type="button"
                      className="wz-chip"
                      aria-pressed={on}
                      onClick={() => {
                        const cur = loc.programs || ["federal"];
                        set(i, {
                          programs: on ? cur.filter((x) => x !== pk) : [...cur, pk],
                        });
                      }}
                    >
                      {(PROGRAMS[pk] || PROGRAMS.federal).label}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
      ))}

      <div className="wz-chips" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="wz-chip wz-chip-add"
          onClick={() => onChange([...list, { name: "", address: "", city: "", state: "", zip: "" }])}
        >
          + Add location
        </button>
      </div>
    </div>
  );
}
