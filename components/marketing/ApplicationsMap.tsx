"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Card, ChipRow, Eyebrow, SectionHeader, Skeleton, StatusPill, fmtMoney, type StatusTone } from "../ui";
import { fetchApplications, type Application, type ApplicationBucket } from "../../lib/marketing";
import { BUCKETS, BUCKET_LABEL, SHADES, byState, filterApplications, shadeFor, yearsIn, type StateSummary } from "../../lib/applications";
import { jurisdiction, slugFromUsps, uspsFromSlug } from "../../lib/states";
import { useMedia } from "../../lib/useMedia";

const StateMap = dynamic(() => import("../StateMap"), { ssr: false });

const TONE: Record<ApplicationBucket, StatusTone> = {
  preparing: "queued",
  pending: "running",
  awarded: "done",
  denied: "error",
  resubmitted: "warn",
  cancelled: "queued",
};

const stateName = (code: string) => (code ? jurisdiction(code)?.name || code : "No state in Salesforce");

/** "3 preparing · 2 submitted · 1 won": the non-zero statuses, in order. */
function breakdown(s: StateSummary): string {
  return BUCKETS.filter((b) => s.counts[b.key])
    .map((b) => `${s.counts[b.key]} ${BUCKET_LABEL[b.key].toLowerCase()}`)
    .join(" · ");
}

/**
 * Every Salesforce grant application, by state. A state's shade is how many
 * applications it has; clicking it (or its chip) lists them below the map.
 * Cancelled applications are hidden unless asked for, the way they are left out
 * of the figures above.
 */
export default function ApplicationsMap() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [year, setYear] = useState("all");
  const [showCancelled, setShowCancelled] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const narrow = useMedia("(max-width: 760px)");

  useEffect(() => {
    fetchApplications()
      .then(setApps)
      .catch(() => setFailed(true));
  }, []);

  const shown = useMemo(() => (apps ? filterApplications(apps, { year, showCancelled }) : []), [apps, year, showCancelled]);
  const states = useMemo(() => byState(shown), [shown]);
  const ranked = useMemo(() => [...states.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)), [states]);
  const years = useMemo(() => (apps ? yearsIn(apps) : []), [apps]);
  const cancelledCount = useMemo(
    () => (apps ? filterApplications(apps, { year, showCancelled: true }).filter((a) => a.status_bucket === "cancelled").length : 0),
    [apps, year]
  );
  const totals = useMemo(() => byState(shown.map((a) => ({ ...a, state: "ALL" }))).get("ALL"), [shown]);
  // A year filter can empty the picked state; then nothing is selected.
  const selected = picked ? states.get(picked) : undefined;

  // An endpoint the backend does not have yet just hides the section.
  if (failed) return null;

  const summaryOf = (slug: string) => states.get(uspsFromSlug(slug) || "");

  return (
    <Card style={{ marginTop: 18 }}>
      <SectionHeader
        title="Applications by state"
        meta={apps ? `${shown.length} ${shown.length === 1 ? "application" : "applications"} in ${ranked.filter((s) => s.code).length} states` : undefined}
        actions={
          years.length > 0 && (
            <ChipRow<string>
              label="Grant year"
              options={[{ key: "all", label: "All years" }, ...years.map((y) => ({ key: y, label: y }))]}
              value={year}
              onChange={setYear}
            />
          )
        }
        style={{ marginBottom: 14 }}
      />

      {!apps && <Skeleton rows={5} />}

      {apps && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {[...SHADES].reverse().map((s) => (
                <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--sec)" }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: shadeFor(s.min), display: "inline-block" }} />
                  {s.label}
                </span>
              ))}
            </div>
            {cancelledCount > 0 && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--sec)", cursor: "pointer" }}>
                <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
                Show cancelled ({cancelledCount})
              </label>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) 200px", gap: 22, alignItems: "start" }}>
            <StateMap
              colorFor={(slug) => shadeFor(summaryOf(slug)?.total || 0)}
              selected={selected ? slugFromUsps(selected.code) : null}
              onSelect={(slug) => {
                const code = uspsFromSlug(slug);
                if (code && states.has(code)) setPicked(code === picked ? null : code);
              }}
              ariaLabelFor={(slug) => {
                const s = summaryOf(slug);
                return `${stateName(uspsFromSlug(slug) || slug)}: ${s ? `${s.total} applications` : "no applications"}`;
              }}
              renderTooltip={(slug) => {
                const code = uspsFromSlug(slug) || "";
                const s = states.get(code);
                return (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{stateName(code)}</div>
                    {!s && <div style={{ fontSize: 12, opacity: 0.75 }}>No applications</div>}
                    {s && (
                      <>
                        <div style={{ fontSize: 12, marginBottom: 3 }}>
                          {s.total} {s.total === 1 ? "application" : "applications"}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.9 }}>{breakdown(s)}</div>
                        {(s.awarded > 0 || s.pending > 0) && (
                          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 5 }}>
                            {[s.awarded > 0 && `${fmtMoney(s.awarded)} won`, s.pending > 0 && `${fmtMoney(s.pending)} awaiting`].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </>
                    )}
                  </>
                );
              }}
            />

            <div>
              {totals && (
                <div style={{ marginBottom: 16 }}>
                  <Eyebrow style={{ marginBottom: 7 }}>{year === "all" ? "All years" : year}</Eyebrow>
                  {BUCKETS.filter((b) => b.key !== "cancelled" || showCancelled).map((b) => (
                    <div key={b.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, lineHeight: "24px", color: totals.counts[b.key] ? "var(--ink)" : "var(--mute)" }}>
                      <span>{b.label}</span>
                      <span className="mono">{totals.counts[b.key]}</span>
                    </div>
                  ))}
                </div>
              )}
              <Eyebrow style={{ marginBottom: 7 }}>States</Eyebrow>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ranked.map((s) => (
                  <button
                    key={s.code || "none"}
                    type="button"
                    onClick={() => setPicked(s.code === picked ? null : s.code)}
                    aria-pressed={s.code === picked}
                    title={stateName(s.code)}
                    className="chip"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {s.code || "No state"} {s.total}
                  </button>
                ))}
                {!ranked.length && <div style={{ fontSize: 14, color: "var(--mute)" }}>No applications for {year}.</div>}
              </div>
            </div>
          </div>

          {selected && <StateList s={selected} onClose={() => setPicked(null)} narrow={narrow} />}
        </>
      )}
    </Card>
  );
}

function StateList({ s, onClose, narrow }: { s: StateSummary; onClose: () => void; narrow: boolean }) {
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--hair2)" }}>
      <SectionHeader
        title={stateName(s.code)}
        meta={`${s.total} ${s.total === 1 ? "application" : "applications"} · ${breakdown(s)}`}
        actions={
          <button type="button" onClick={onClose} className="btn btn-quiet btn-sm" aria-label="Close the list">
            <X size={15} strokeWidth={1.75} aria-hidden /> Close
          </button>
        }
        style={{ marginBottom: 8 }}
      />
      {(s.awarded > 0 || s.pending > 0) && (
        <div style={{ fontSize: 14, color: "var(--sec)", marginBottom: 10 }}>
          {[s.awarded > 0 && `${fmtMoney(s.awarded)} won`, s.pending > 0 && `${fmtMoney(s.pending)} submitted and awaiting notification`].filter(Boolean).join(" · ")}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, lineHeight: 1.45 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--mute)", fontSize: 12 }}>
              <th style={th}>Organization</th>
              <th style={th}>Program</th>
              <th style={th}>Status</th>
              {!narrow && <th style={{ ...th, textAlign: "right" }}>Requested</th>}
              <th style={{ ...th, textAlign: "right" }}>Awarded</th>
            </tr>
          </thead>
          <tbody>
            {s.apps.map((a) => (
              <tr key={a.application_id} style={{ borderTop: "1px solid var(--hair2)" }}>
                <td style={{ ...td, color: "var(--ink)" }}>{a.organization || a.name || "Unnamed"}</td>
                <td style={{ ...td, color: "var(--sec)", whiteSpace: "nowrap" }}>{a.grant_program || "-"}</td>
                <td style={td} title={a.status || undefined}>
                  <StatusPill tone={TONE[a.status_bucket]}>{BUCKET_LABEL[a.status_bucket]}</StatusPill>
                </td>
                {!narrow && <td style={{ ...td, textAlign: "right" }} className="mono">{a.amount_requested ? fmtMoney(a.amount_requested) : "-"}</td>}
                <td style={{ ...td, textAlign: "right" }} className="mono">{a.status_bucket === "awarded" && a.amount_awarded ? fmtMoney(a.amount_awarded) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 10px 6px 0", fontWeight: 500 };
const td: React.CSSProperties = { padding: "9px 10px 9px 0", verticalAlign: "top" };
