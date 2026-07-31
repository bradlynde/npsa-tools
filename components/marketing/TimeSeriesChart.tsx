"use client";

import { useMemo, useState } from "react";
import { Card, Eyebrow, SegPill, Note, fmtMoney } from "../ui";
import { periodLabel, type Granularity, type TimeseriesRow } from "../../lib/marketing";

export type Metric = "booked" | "held" | "loes" | "won";

const METRICS: { key: Metric; label: string; title: string; money: boolean }[] = [
  { key: "booked", label: "Bookings", title: "bookings", money: false },
  { key: "held", label: "Held", title: "held meetings", money: false },
  { key: "loes", label: "LOEs", title: "loes sent", money: false },
  { key: "won", label: "Won $", title: "won revenue", money: true },
];

const GRANS: { key: Granularity; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

function valueOf(r: TimeseriesRow | undefined, metric: Metric): number {
  if (!r) return 0;
  if (metric === "booked") return Number(r.booked) || 0;
  if (metric === "held") return Number(r.held) || 0;
  if (metric === "loes") return Number(r.clients) || 0;
  return Number(r.won_amount) || 0;
}

export default function TimeSeriesChart({
  series,
  gran,
  onGranChange,
  loading,
}: {
  series: TimeseriesRow[];
  gran: Granularity;
  onGranChange: (g: Granularity) => void;
  loading: boolean;
}) {
  const [metric, setMetric] = useState<Metric>("booked");
  const [compare, setCompare] = useState(false);
  const [offset, setOffset] = useState(0); // periods scrolled back from newest
  const [tip, setTip] = useState(-1);

  const cfg = METRICS.find((m) => m.key === metric)!;
  const fmt = (v: number) => (cfg.money ? fmtMoney(v) : Math.round(v).toLocaleString("en-US"));

  // Visible window, pannable back through history with the stepper.
  const WINDOW = gran === "week" ? 14 : 12;
  const sorted = useMemo(
    () => [...series].sort((a, b) => a.period.localeCompare(b.period)),
    [series]
  );
  const maxOffset = Math.max(0, sorted.length - WINDOW);
  const off = Math.min(offset, maxOffset);
  const end = sorted.length - off;
  const start = Math.max(0, end - WINDOW);
  const shown = sorted.slice(start, end);

  const ghostOf = (i: number) => (compare ? valueOf(sorted[start + i - 1], metric) : 0);
  const maxVal = Math.max(
    1,
    ...shown.map((s) => valueOf(s, metric)),
    ...shown.map((_, i) => ghostOf(i))
  );

  const step = Math.max(1, Math.round(WINDOW / 2));
  const canOlder = off < maxOffset;
  const canNewer = off > 0;
  const rangeLabel = shown.length
    ? `${periodLabel(shown[0].period, gran)} – ${periodLabel(shown[shown.length - 1].period, gran)}`
    : "";

  // ~7 evenly spaced x labels, first and last always shown, so they never collide.
  const labelIdx = useMemo(() => {
    const n = shown.length;
    const t = Math.min(7, n);
    const set = new Set<number>();
    for (let k = 0; k < t; k++) set.add(Math.round((k * (n - 1)) / (t - 1 || 1)));
    return set;
  }, [shown.length]);

  const barColor = cfg.money ? "var(--olive)" : "var(--navy)";

  return (
    <Card style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <Eyebrow>
          {cfg.title} over time — by {gran}
        </Eyebrow>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <SegPill
            options={GRANS}
            value={gran}
            onChange={(g) => {
              onGranChange(g);
              setOffset(0);
            }}
            size="sm"
          />
          <SegPill options={METRICS} value={metric} onChange={setMetric} size="sm" />
        </div>
      </div>

      {loading ? (
        <Note>Loading…</Note>
      ) : shown.length === 0 ? (
        <Note>No bookings recorded yet.</Note>
      ) : (
        <>
          <div style={{ position: "relative" }}>
            {tip >= 0 && shown[tip] && (
              <div
                className="mono"
                style={{
                  position: "absolute",
                  top: -6,
                  left: `${((tip + 0.5) / shown.length) * 100}%`,
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
                {periodLabel(shown[tip].period, gran)} — {fmt(valueOf(shown[tip], metric))}
                {compare && sorted[start + tip - 1] && (
                  <>
                    {" "}
                    <span style={{ opacity: 0.65 }}>
                      ({valueOf(shown[tip], metric) - ghostOf(tip) >= 0 ? "+" : ""}
                      {fmt(valueOf(shown[tip], metric) - ghostOf(tip))} vs prev)
                    </span>
                  </>
                )}
              </div>
            )}

            {/* plot */}
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "flex-end",
                gap: gran === "week" ? 8 : 6,
                height: 150,
              }}
            >
              {/* faint gridlines + baseline */}
              <div
                style={{ position: "absolute", left: 0, right: 0, top: 0, borderTop: "1px dashed var(--hair2)" }}
              />
              <div
                style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: "1px dashed var(--hair2)" }}
              />
              <div
                style={{ position: "absolute", left: 0, right: 0, bottom: 0, borderTop: "1px solid var(--hair)" }}
              />
              {shown.map((s, i) => {
                const cur = valueOf(s, metric);
                const ghost = ghostOf(i);
                return (
                  <div
                    key={s.period}
                    onMouseEnter={() => setTip(i)}
                    onMouseLeave={() => setTip(-1)}
                    style={{ flex: 1, height: "100%", position: "relative", zIndex: 1, cursor: "pointer" }}
                  >
                    {compare && ghost > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: "50%",
                          transform: "translateX(-50%)",
                          width: gran === "week" ? "86%" : "78%",
                          height: `${(ghost / maxVal) * 100}%`,
                          background: "var(--track)",
                          borderRadius: 5,
                        }}
                        title="previous period"
                      />
                    )}
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: "50%",
                        transform: "translateX(-50%)",
                        width: gran === "week" ? "60%" : "54%",
                        height: `${Math.max(cur > 0 ? 2 : 0, (cur / maxVal) * 100)}%`,
                        background: barColor,
                        borderRadius: 5,
                        transformOrigin: "bottom",
                        animation: "growY .7s cubic-bezier(.34,1.4,.4,1) both",
                        transition: "height .55s cubic-bezier(.34,1.3,.4,1), filter .2s",
                        filter: tip === i ? "brightness(1.2)" : "none",
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {/* x-axis */}
            <div style={{ display: "flex", gap: gran === "week" ? 8 : 6, marginTop: 8 }}>
              {shown.map((s, i) => (
                <div
                  key={s.period}
                  className="mono"
                  style={{
                    flex: 1,
                    textAlign: "center",
                    fontSize: 10,
                    color: "var(--faint)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  {labelIdx.has(i) ? periodLabel(s.period, gran) : ""}
                </div>
              ))}
            </div>
          </div>

          {/* stepper + compare */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 14,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => canOlder && setOffset((o) => Math.min(maxOffset, o + step))}
                disabled={!canOlder}
                aria-label="Show earlier periods"
                style={{
                  border: "1px solid var(--bd2)",
                  background: "transparent",
                  color: canOlder ? "var(--navy)" : "var(--faint)",
                  borderRadius: 999,
                  padding: "3px 11px",
                  fontSize: 14,
                  cursor: canOlder ? "pointer" : "default",
                  lineHeight: 1.4,
                }}
              >
                ‹
              </button>
              <span
                className="mono"
                style={{ fontSize: 11.5, color: "var(--mute)", minWidth: 120, textAlign: "center" }}
              >
                {rangeLabel}
              </span>
              <button
                type="button"
                onClick={() => canNewer && setOffset((o) => Math.max(0, o - step))}
                disabled={!canNewer}
                aria-label="Show later periods"
                style={{
                  border: "1px solid var(--bd2)",
                  background: "transparent",
                  color: canNewer ? "var(--navy)" : "var(--faint)",
                  borderRadius: 999,
                  padding: "3px 11px",
                  fontSize: 14,
                  cursor: canNewer ? "pointer" : "default",
                  lineHeight: 1.4,
                }}
              >
                ›
              </button>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12.5,
                color: "var(--sec)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
                style={{ cursor: "pointer", accentColor: "var(--navy)" }}
              />
              Compare previous period
            </label>
          </div>
        </>
      )}
    </Card>
  );
}
