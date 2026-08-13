"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Eyebrow,
  SegPill,
  Note,
  useRoll,
  useElementWidth,
  fmtInt,
  fmtMoney,
} from "../ui";
import {
  AXIS_LABEL_PITCH,
  axisLabelShift,
  axisLabelCount,
  axisLabelIndices,
  fetchUntrackedWins,
  salesPeriodLabel,
  type UntrackedWin,
  type ApplicationStats,
  type SalesGranularity,
  type SalesPoint,
  type Stats,
  type SyncRun,
  type SyncStatus,
} from "../../lib/marketing";

const pct = (n: number) => `${Math.round((n || 0) * 100)}%`;

type SalesMetric = "new_orgs" | "amount" | "contracts";

const SALES_METRICS: { key: SalesMetric; label: string; title: string; money: boolean }[] = [
  { key: "new_orgs", label: "New orgs", title: "new organizations won", money: false },
  { key: "amount", label: "Contract $", title: "contract value", money: true },
  { key: "contracts", label: "Contracts", title: "contracts signed", money: false },
];

const SALES_GRANS: { key: SalesGranularity; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
];

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * A failed run stops describing the present, in two ways.
 *
 * `sync/status` returns the newest run PER SOURCE. So a source that fails once and
 * is then retired keeps that failed row for ever: nothing supersedes it, because
 * nothing writes to it again. This banner reported "any source's newest run
 * failed" as "the last sync failed", with no test of whether it was still true —
 * and stayed red for as long as the row existed.
 *
 * A run is spent once either is true:
 *
 *  - **It is old.** Every source here runs daily, so a run from days ago says
 *    nothing about today's figures.
 *  - **Something newer already did its job.** Financials arrive as either
 *    `salesforce_financials` (mapped field names) or `salesforce_financials_raw`
 *    (Salesforce's own, mapped server-side instead). One dataset, two delivery
 *    routes, so a success on either settles a failure on the other.
 *
 * That second case is the one that went wrong: the mapped route failed at 16:35
 * with an empty payload, the raw route delivered 120 records at 06:00 the next
 * morning, and the dashboard still called the sync failed.
 */
const FRESH_MS = 36 * 3600 * 1000;
/** Two routes for one dataset share a family, so either can settle the other. */
const sourceFamily = (source?: string | null) => (source || "").replace(/_raw$/, "");
const runAt = (r: SyncRun) => new Date(r.finished_at || r.started_at || 0).getTime();

/** Whether the Salesforce data behind these figures actually landed, and when. */
function SyncLine({ status }: { status: SyncStatus | null }) {
  if (!status) return null;
  const runs = status.runs || [];
  const current = runs.filter((r) => Date.now() - runAt(r) < FRESH_MS);

  // Newest success per dataset, so a later success can settle an earlier failure.
  const settled = new Map<string, number>();
  for (const r of current) {
    if (!r.ok) continue;
    const key = sourceFamily(r.source);
    settled.set(key, Math.max(settled.get(key) ?? 0, runAt(r)));
  }
  const failed = current
    .filter((r) => r.ok === false && runAt(r) > (settled.get(sourceFamily(r.source)) ?? 0))
    .sort((a, b) => runAt(b) - runAt(a));

  // "When did anything last land" is asked of every run, spent or not — a wholly
  // stale board should still say when it went stale rather than claim nothing ran.
  const newest = runs.reduce(
    (max, r) => (r.finished_at && r.finished_at > max ? r.finished_at : max),
    ""
  );
  const stale = newest && Date.now() - new Date(newest).getTime() > 24 * 3600 * 1000;

  let tone = "var(--mute)";
  let text: string;
  let reported: SyncRun | undefined;
  if (!runs.length) {
    text = status.pull_configured
      ? "Salesforce sync has not run yet"
      : "Salesforce sync not configured — figures are from the last manual load";
  } else if (failed.length) {
    reported = failed[0];
    tone = "var(--err-fg)";
    text = `Last Salesforce sync failed — ${reported.error || "unknown error"}`;
  } else if (!newest) {
    text = "Salesforce sync started but has not finished";
  } else {
    reported = runs.find((r) => r.finished_at === newest);
    const seen = (current.length ? current : runs).reduce((s, r) => s + (r.rows_seen || 0), 0);
    tone = stale ? "var(--warn-fg)" : "var(--ok-fg)";
    text = `Synced from Salesforce ${timeAgo(newest)} · ${seen.toLocaleString()} records`;
  }
  // The note belongs to the run being reported. Taking the first note from any run
  // sat a fortnight-old Calendly backfill's "scanned 103" beside a financials error,
  // reading as one sentence about one event.
  const note = reported?.note || null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 0 14px",
        fontSize: 12.5,
        color: tone,
      }}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: "50%", background: tone, flexShrink: 0 }}
        aria-hidden="true"
      />
      <span>
        {text}
        {note ? ` · ${note}` : ""}
      </span>
    </div>
  );
}

/**
 * The sales side of the business: organisations won, what they're worth, and the
 * grant applications those contracts produce. All-time, straight from Salesforce.
 */
export default function SalesBand({
  stats,
  apps,
  series,
  gran,
  onGranChange,
  sync,
}: {
  stats: Stats;
  apps: ApplicationStats | null;
  series: SalesPoint[];
  gran: SalesGranularity;
  onGranChange: (g: SalesGranularity) => void;
  sync: SyncStatus | null;
}) {
  const [showPrograms, setShowPrograms] = useState(false);
  const [showUntracked, setShowUntracked] = useState(false);
  const [untracked, setUntracked] = useState<UntrackedWin[]>([]);
  const [loadingUntracked, setLoadingUntracked] = useState(false);
  const [metric, setMetric] = useState<SalesMetric>("new_orgs");
  const [cumulative, setCumulative] = useState(false);
  const [tip, setTip] = useState(-1);
  const roll = useRoll(`sales-${stats.won_revenue_total}-${apps?.total ?? 0}`);

  useEffect(() => {
    if (!showUntracked || untracked.length > 0) return;
    setLoadingUntracked(true);
    fetchUntrackedWins()
      .then(setUntracked)
      .catch(() => setUntracked([]))
      .finally(() => setLoadingUntracked(false));
  }, [showUntracked, untracked.length]);

  const cfg = SALES_METRICS.find((m) => m.key === metric)!;
  const fmtVal = (v: number) => (cfg.money ? fmtMoney(v) : fmtInt(v));

  const points = useMemo(() => {
    const raw = [...series].sort((a, b) => a.period.localeCompare(b.period));
    if (!cumulative) return raw.map((p) => ({ period: p.period, value: p[metric] }));
    let acc = 0;
    return raw.map((p) => {
      acc += p[metric];
      return { period: p.period, value: acc };
    });
  }, [series, metric, cumulative]);

  const maxVal = Math.max(1, ...points.map((p) => p.value));
  const total = cumulative
    ? points[points.length - 1]?.value || 0
    : points.reduce((n, p) => n + p.value, 0);

  // As many evenly spaced x labels as the axis is actually wide enough for.
  const [axisRef, axisWidth] = useElementWidth<HTMLDivElement>();
  // Months and quarters both set wide labels, so both take the long pitch.
  const labelIdx = useMemo(
    () => axisLabelIndices(points.length, axisLabelCount(axisWidth, AXIS_LABEL_PITCH.long)),
    [points.length, axisWidth]
  );
  const slotWidth =
    axisWidth && points.length ? (axisWidth - 6 * (points.length - 1)) / points.length : 0;
  const firstLabelled = labelIdx.size ? Math.min(...labelIdx) : -1;

  return (
    <>
      <Eyebrow style={{ margin: "6px 0 10px" }}>sales · from salesforce</Eyebrow>
      <SyncLine status={sync} />

      {/* Organisations won, what they're worth, and the applications they drive */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div
          className="lift-accent"
          style={{ background: "var(--navycard)", borderRadius: 16, padding: "22px 24px" }}
        >
          <div className="kpi" style={{ color: "#fff", fontSize: 36 }}>
            {/* Older backends don't return the distinct-org count. Falling back to
                the contract count beats showing a confident zero. */}
            {fmtInt((stats.won_org_count ?? stats.won_count_total ?? 0) * roll)}
          </div>
          <div
            className="mono"
            style={{
              color: "rgba(255,255,255,.85)",
              fontSize: 11.5,
              marginTop: 10,
              letterSpacing: ".07em",
              fontWeight: 500,
            }}
          >
            organizations won
          </div>
          <div style={{ color: "rgba(255,255,255,.75)", fontSize: 12.5, marginTop: 5 }}>
            {stats.won_count_total} {stats.won_count_total === 1 ? "contract" : "contracts"} signed
          </div>
        </div>

        {/* Contract value carries the olive: it is the number people look for. */}
        <div
          className="lift-accent"
          style={{ background: "var(--olive)", borderRadius: 16, padding: "22px 24px" }}
        >
          <div className="kpi" style={{ color: "#fff", fontSize: 36 }}>
            {fmtMoney(stats.won_revenue_total * roll)}
          </div>
          <div
            className="mono"
            style={{
              color: "rgba(255,255,255,.8)",
              fontSize: 11.5,
              marginTop: 10,
              letterSpacing: ".07em",
              fontWeight: 500,
            }}
          >
            contract value
          </div>
          <div style={{ color: "rgba(255,255,255,.72)", fontSize: 12.5, marginTop: 5 }}>
            NPSA revenue won
          </div>
          {stats.untracked_count > 0 && (
            <button
              type="button"
              onClick={() => setShowUntracked((v) => !v)}
              aria-expanded={showUntracked}
              style={{
                marginTop: 9,
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                fontSize: 12,
                fontWeight: 700,
                color: "rgba(255,255,255,.85)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {fmtMoney(stats.untracked_revenue)} closed before the funnel ·{" "}
              {showUntracked ? "hide" : "show"} {stats.untracked_count}{" "}
              {stats.untracked_count === 1 ? "deal" : "deals"} {showUntracked ? "▾" : "▸"}
            </button>
          )}
        </div>

        {apps && (
          <div
            className="lift-accent"
            style={{ background: "var(--navycard)", borderRadius: 16, padding: "22px 24px" }}
          >
            <div className="kpi" style={{ color: "#fff", fontSize: 36 }}>
              {fmtInt(apps.total * roll)}
            </div>
            <div
              className="mono"
              style={{
                color: "rgba(255,255,255,.8)",
                fontSize: 11.5,
                marginTop: 10,
                letterSpacing: ".07em",
                fontWeight: 500,
              }}
            >
              grant applications
            </div>
            <div style={{ color: "rgba(255,255,255,.72)", fontSize: 12.5, marginTop: 5 }}>
              {apps.preparing_count} preparing · {apps.pending_count} submitted
            </div>
          </div>
        )}
      </div>

      {showUntracked && (
        <Card style={{ padding: "8px 6px", marginBottom: 14 }} className="fade-up">
          <div
            className="mono"
            style={{
              display: "flex",
              fontSize: 10.5,
              fontWeight: 600,
              color: "var(--faint)",
              letterSpacing: ".07em",
              padding: "10px 16px",
            }}
          >
            <div style={{ flex: 1 }}>CLOSED BEFORE THE FUNNEL</div>
            <div style={{ width: 120, textAlign: "right" }}>CLOSED</div>
            <div style={{ width: 110, textAlign: "right" }}>AMOUNT</div>
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {loadingUntracked && <Note>Loading…</Note>}
            {!loadingUntracked && untracked.length === 0 && <Note>Nothing to show.</Note>}
            {untracked.map((u) => (
              <div
                key={u.opportunity_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "11px 16px",
                  borderTop: "1px solid var(--hair2)",
                  fontSize: 13.5,
                }}
              >
                <div style={{ flex: 1, color: "var(--ink)", fontWeight: 600 }}>
                  {u.organization || "—"}
                </div>
                <div
                  style={{
                    width: 120,
                    textAlign: "right",
                    color: "var(--mute)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {u.close_date
                    ? new Date(u.close_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "—"}
                </div>
                <div
                  style={{
                    width: 110,
                    textAlign: "right",
                    fontWeight: 700,
                    color: "var(--ink)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtMoney(u.amount)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Grant dollars: brought in vs still in play */}
      {apps && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
            gap: 14,
            marginBottom: 14,
          }}
        >
          <Card hover style={{ padding: "20px 22px" }}>
            <div
              className="mono"
              style={{ fontWeight: 500, fontSize: 11.5, letterSpacing: ".07em", color: "var(--mute)" }}
            >
              awarded to clients
            </div>
            <div className="kpi" style={{ fontSize: 30, marginTop: 8, color: "var(--olive)" }}>
              {fmtMoney(apps.awarded_amount * roll)}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 6 }}>
              {apps.awarded_count} accepted{" "}
              {apps.awarded_count === 1 ? "application" : "applications"}
            </div>
          </Card>

          <Card hover style={{ padding: "20px 22px" }}>
            <div
              className="mono"
              style={{ fontWeight: 500, fontSize: 11.5, letterSpacing: ".07em", color: "var(--mute)" }}
            >
              pending award
            </div>
            <div className="kpi" style={{ fontSize: 30, marginTop: 8, color: "var(--ink)" }}>
              {fmtMoney(apps.pending_amount * roll)}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 6 }}>
              {apps.pending_count} submitted, awaiting notification
            </div>
          </Card>

          <Card hover style={{ padding: "20px 22px" }}>
            <div
              className="mono"
              style={{ fontWeight: 500, fontSize: 11.5, letterSpacing: ".07em", color: "var(--mute)" }}
            >
              acceptance rate
            </div>
            <div className="kpi" style={{ fontSize: 30, marginTop: 8, color: "var(--ink)" }}>
              {pct(apps.acceptance_rate * roll)}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 6 }}>
              {apps.awarded_count} of {apps.awarded_count + apps.denied_count} decided
              {apps.award_fill_rate > 0 ? ` · ${pct(apps.award_fill_rate)} of ask funded` : ""}
            </div>
          </Card>
        </div>
      )}

      {/* By grant program */}
      {apps && apps.by_program?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => setShowPrograms((v) => !v)}
            aria-expanded={showPrograms}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--navy)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
              font: "inherit",
              marginBottom: showPrograms ? 10 : 0,
            }}
          >
            {showPrograms ? "Hide" : "Show"} breakdown by grant program{" "}
            {showPrograms ? "▾" : "▸"}
          </button>
          {showPrograms && (
            <Card style={{ padding: "8px 6px" }} className="fade-up">
              <div
                className="mono"
                style={{
                  display: "flex",
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "var(--faint)",
                  letterSpacing: ".07em",
                  padding: "10px 16px",
                }}
              >
                <div style={{ flex: 2 }}>PROGRAM</div>
                <div style={{ flex: 1, textAlign: "right" }}>APPS</div>
                <div style={{ flex: 1, textAlign: "right" }}>AWARDED</div>
                <div style={{ flex: 1, textAlign: "right" }}>PENDING</div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {apps.by_program.map((p) => (
                  <div
                    key={p.grant_program}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "11px 16px",
                      borderTop: "1px solid var(--hair2)",
                      fontSize: 13.5,
                    }}
                  >
                    <div style={{ flex: 2, color: "var(--ink)", fontWeight: 600 }}>
                      {p.grant_program}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        textAlign: "right",
                        color: "var(--sec)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {p.total}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        textAlign: "right",
                        fontWeight: 700,
                        color: p.awarded_amount ? "var(--olive)" : "var(--faint)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {p.awarded_amount ? fmtMoney(p.awarded_amount) : "—"}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        textAlign: "right",
                        color: "var(--sec)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {p.pending_amount ? fmtMoney(p.pending_amount) : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Sales trend — momentum, not just all-time totals */}
      {series.length > 0 && (
        <Card style={{ marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: 14,
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <Eyebrow>
                {cfg.title} over time{cumulative ? " (cumulative)" : ""}
              </Eyebrow>
              <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 5 }}>
                {cumulative ? "Running total · now at " : "Total shown · "}
                <strong style={{ color: "var(--olive)" }}>{fmtVal(total)}</strong>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <SegPill options={SALES_GRANS} value={gran} onChange={onGranChange} size="sm" />
              <SegPill options={SALES_METRICS} value={metric} onChange={setMetric} size="sm" />
            </div>
          </div>

          {points.length === 0 ? (
            <Note>No wins recorded yet.</Note>
          ) : (
            <>
              <div style={{ position: "relative" }}>
                {tip >= 0 && points[tip] && (
                  <div
                    className="mono"
                    style={{
                      position: "absolute",
                      top: -6,
                      left: `${((tip + 0.5) / points.length) * 100}%`,
                      zIndex: 5,
                      pointerEvents: "none",
                      transform: "translate(-50%,-100%)",
                      background: "var(--tip-bg)",
                      color: "var(--tip-fg)",
                      fontWeight: 600,
                      fontSize: 12,
                      padding: "6px 11px",
                      borderRadius: 8,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {salesPeriodLabel(points[tip].period, gran)} — {fmtVal(points[tip].value)}
                  </div>
                )}
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "flex-end",
                    gap: 6,
                    height: 130,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 0,
                      borderTop: "1px dashed var(--hair2)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: "50%",
                      borderTop: "1px dashed var(--hair2)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      borderTop: "1px solid var(--hair)",
                    }}
                  />
                  {points.map((p, i) => (
                    <div
                      key={p.period}
                      onMouseEnter={() => setTip(i)}
                      onMouseLeave={() => setTip(-1)}
                      style={{
                        flex: 1,
                        height: "100%",
                        position: "relative",
                        zIndex: 1,
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          // Centred with symmetric insets rather than
                          // translateX(-50%). growY animates `transform`, and an
                          // animation with fill-mode `both` keeps its final
                          // keyframe applied — outranking the inline transform
                          // and dropping the centring, which left every bar half
                          // its own width right of the label naming it.
                          left: "22%",
                          right: "22%",
                          height: `${Math.max(p.value > 0 ? 2 : 0, (p.value / maxVal) * 100)}%`,
                          background: "var(--olive)",
                          borderRadius: 5,
                          transformOrigin: "bottom",
                          animation: "growY .7s cubic-bezier(.34,1.4,.4,1) both",
                          transition: "height .55s cubic-bezier(.34,1.3,.4,1), filter .2s",
                          filter: tip === i ? "brightness(1.15)" : "none",
                        }}
                      />
                    </div>
                  ))}
                </div>
                {/* Labels are positioned rather than laid out in their slot: a
                    month label is wider than the bar it names, and text-align
                    does not centre text that overflows its box. */}
                <div
                  ref={axisRef}
                  style={{ display: "flex", gap: 6, marginTop: 8, height: 13 }}
                >
                  {points.map((p, i) => {
                    const label = labelIdx.has(i) ? salesPeriodLabel(p.period, gran) : "";
                    const shift = axisLabelShift(i, label, {
                      slotWidth,
                      firstLabelled,
                      lastIndex: points.length - 1,
                    });
                    return (
                      <div key={p.period} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                        {label && (
                          <span
                            className="mono"
                            style={{
                              position: "absolute",
                              top: 0,
                              left: "50%",
                              transform: `translateX(calc(-50% + ${shift}px))`,
                              fontSize: 10,
                              lineHeight: "13px",
                              color: "var(--faint)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  marginTop: 14,
                  fontSize: 12.5,
                  color: "var(--sec)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={cumulative}
                  onChange={(e) => setCumulative(e.target.checked)}
                  style={{ cursor: "pointer", accentColor: "var(--navy)" }}
                />
                Show cumulative growth
              </label>
            </>
          )}
        </Card>
      )}
    </>
  );
}
