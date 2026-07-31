"use client";

import { useEffect, useState } from "react";
import { Card, Eyebrow, Note, fmtMoney } from "../ui";
import { fetchUntrackedWins, type Stats, type UntrackedWin } from "../../lib/marketing";

const pct = (n: number) => `${Math.round((n || 0) * 100)}%`;

/**
 * Salesforce revenue layer: total won, how much of it the funnel can attribute
 * to a tracked booking, and the untracked/pre-funnel remainder. All-time by
 * design — these come straight from Salesforce, not the booking time series.
 */
export default function SalesforceBand({ stats }: { stats: Stats }) {
  const [showUntracked, setShowUntracked] = useState(false);
  const [untracked, setUntracked] = useState<UntrackedWin[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  useEffect(() => {
    if (!showUntracked || untracked.length > 0) return;
    setLoadingList(true);
    fetchUntrackedWins()
      .then(setUntracked)
      .catch(() => setUntracked([]))
      .finally(() => setLoadingList(false));
  }, [showUntracked, untracked.length]);

  const coverage = Math.round((stats.attribution_coverage || 0) * 100);

  return (
    <>
      <Eyebrow style={{ margin: "6px 0 12px" }}>salesforce performance · all time</Eyebrow>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        {/* Total won — the headline */}
        <div
          style={{
            background: "var(--navycard)",
            borderRadius: 16,
            padding: "22px 24px",
            boxShadow: "var(--shadow-navy)",
          }}
        >
          <div className="kpi" style={{ color: "#fff", fontSize: 36 }}>
            {fmtMoney(stats.won_revenue_total)}
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
            total won revenue
          </div>
          <div style={{ color: "rgba(255,255,255,.72)", fontSize: 12.5, marginTop: 5 }}>
            {stats.won_count_total} {stats.won_count_total === 1 ? "win" : "wins"} in Salesforce
          </div>
        </div>

        {/* Attributed to the funnel */}
        <Card style={{ padding: "20px 22px" }}>
          <div
            className="mono"
            style={{ fontWeight: 500, fontSize: 11.5, letterSpacing: ".07em", color: "var(--mute)" }}
          >
            attributed to funnel
          </div>
          <div className="kpi" style={{ fontSize: 32, marginTop: 8, color: "var(--ink)" }}>
            {fmtMoney(stats.attributed_revenue)}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 6 }}>
            {pct(stats.attribution_coverage)} of won revenue · {stats.attributed_count}{" "}
            {stats.attributed_count === 1 ? "win" : "wins"}
          </div>
        </Card>

        {/* Untracked / pre-funnel */}
        <Card style={{ padding: "20px 22px" }}>
          <div
            className="mono"
            style={{ fontWeight: 500, fontSize: 11.5, letterSpacing: ".07em", color: "var(--mute)" }}
          >
            untracked / pre-funnel
          </div>
          <div className="kpi" style={{ fontSize: 32, marginTop: 8, color: "var(--ink)" }}>
            {fmtMoney(stats.untracked_revenue)}
          </div>
          {stats.untracked_count > 0 ? (
            <button
              type="button"
              onClick={() => setShowUntracked((v) => !v)}
              aria-expanded={showUntracked}
              style={{
                marginTop: 6,
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--navy)",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {stats.untracked_count} {stats.untracked_count === 1 ? "deal" : "deals"} ·{" "}
              {showUntracked ? "hide" : "show"} list {showUntracked ? "▾" : "▸"}
            </button>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 6 }}>none</div>
          )}
        </Card>
      </div>

      {/* Attribution coverage meter */}
      <Card style={{ padding: "14px 18px", marginBottom: showUntracked ? 12 : 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            fontSize: 12.5,
            color: "var(--sec)",
            marginBottom: 9,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700 }}>Attribution coverage</span>
          <span>{pct(stats.attribution_coverage)} of won revenue traces to a tracked booking</span>
        </div>
        <div style={{ height: 10, borderRadius: 999, background: "var(--track)", overflow: "hidden" }}>
          <div
            style={{
              width: `${coverage}%`,
              height: "100%",
              background: "var(--olive)",
              borderRadius: 999,
              transition: "width .6s cubic-bezier(.34,1.3,.4,1)",
            }}
          />
        </div>
      </Card>

      {/* Collapsible untracked wins */}
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
            <div style={{ flex: 1 }}>ORGANIZATION</div>
            <div style={{ width: 120, textAlign: "right" }}>CLOSED</div>
            <div style={{ width: 110, textAlign: "right" }}>AMOUNT</div>
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {loadingList && <Note>Loading…</Note>}
            {!loadingList && untracked.length === 0 && <Note>No untracked wins.</Note>}
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
    </>
  );
}
