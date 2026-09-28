"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, SegPill, Note, fmtMoney, useElementWidth } from "../ui";
import {
  AXIS_LABEL_PITCH,
  axisLabelShift,
  axisLabelCount,
  axisLabelIndices,
  periodLabel,
  type Granularity,
  type TimeseriesRow,
} from "../../lib/marketing";

export type Metric = "booked" | "held" | "loes" | "won";

const METRICS: { key: Metric; label: string; title: string; money: boolean }[] = [
  { key: "booked", label: "Bookings", title: "Bookings", money: false },
  { key: "held", label: "Held", title: "Held meetings", money: false },
  { key: "loes", label: "LOEs", title: "LOEs sent", money: false },
  { key: "won", label: "Won $", title: "Won revenue", money: true },
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

  // As many evenly spaced x labels as the axis is actually wide enough for:
  // every bar on a desktop card, a thinned subset on a phone.
  const [axisRef, axisWidth] = useElementWidth<HTMLDivElement>();
  const labelIdx = useMemo(
    () =>
      axisLabelIndices(
        shown.length,
        axisLabelCount(
          axisWidth,
          gran === "week" ? AXIS_LABEL_PITCH.short : AXIS_LABEL_PITCH.long
        )
      ),
    [shown.length, axisWidth, gran]
  );

  const axisGap = gran === "week" ? 8 : 6;
  const slotWidth =
    axisWidth && shown.length
      ? (axisWidth - axisGap * (shown.length - 1)) / shown.length
      : 0;
  const firstLabelled = labelIdx.size ? Math.min(...labelIdx) : -1;

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
        <div>
          <h3 className="section-title">{cfg.title} over time</h3>
          <div className="meta">By {gran}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <SegPill
            options={GRANS}
            value={gran}
            onChange={(g) => {
              onGranChange(g);
              setOffset(0);
            }}
            size="sm"
            label="Period"
          />
          <SegPill options={METRICS} value={metric} onChange={setMetric} size="sm" label="Measure" />
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
                style={{
                  position: "absolute",
                  top: -6,
                  left: `${((tip + 0.5) / shown.length) * 100}%`,
                  zIndex: 5,
                  pointerEvents: "none",
                  transform: "translate(-50%,-100%)",
                  background: "var(--tip-bg)",
                  color: "var(--tip-fg)",
                  fontWeight: 500,
                  fontSize: 12,
                  lineHeight: "16px",
                  padding: "6px 10px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                  boxShadow: "var(--shadow-pop)",
                }}
              >
                {periodLabel(shown[tip].period, gran)} · {fmt(valueOf(shown[tip], metric))}
                {compare && sorted[start + tip - 1] && (
                  <>
                    {" "}
                    <span style={{ opacity: 0.75 }}>
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
                          // Centred by symmetric insets, not translateX — see
                          // the note on the live bar below.
                          left: gran === "week" ? "7%" : "11%",
                          right: gran === "week" ? "7%" : "11%",
                          height: `${(ghost / maxVal) * 100}%`,
                          background: "var(--ghost)",
                          borderRadius: "4px 4px 0 0",
                        }}
                        title="previous period"
                      />
                    )}
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        // Centred with symmetric insets rather than
                        // translateX(-50%). growY animates `transform`, and an
                        // animation with fill-mode `both` keeps its final
                        // keyframe applied — outranking the inline transform and
                        // dropping the centring, which left every bar sitting
                        // half its own width right of the label naming it.
                        left: gran === "week" ? "20%" : "23%",
                        right: gran === "week" ? "20%" : "23%",
                        height: `${Math.max(cur > 0 ? 2 : 0, (cur / maxVal) * 100)}%`,
                        background: barColor,
                        borderRadius: "4px 4px 0 0",
                        transformOrigin: "bottom",
                        animation: "growY .6s cubic-bezier(.2,.8,.2,1) both",
                        transition: "height .45s cubic-bezier(.2,.8,.2,1), opacity .15s",
                        opacity: tip >= 0 && tip !== i ? 0.55 : 1,
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {/* x-axis. Each slot matches a bar; the label is positioned rather
                than laid out inside it, because a label is routinely wider than
                the bar it names and `text-align` will not centre — or even
                right-align — text that overflows its box. Absolute centring is
                exact at any width, and the shift pulls the outermost labels back
                inside the plot. */}
            <div
              ref={axisRef}
              style={{ display: "flex", gap: axisGap, marginTop: 8, height: 16 }}
            >
              {shown.map((s, i) => {
                const label = labelIdx.has(i) ? periodLabel(s.period, gran) : "";
                const shift = axisLabelShift(i, label, {
                  slotWidth,
                  firstLabelled,
                  lastIndex: shown.length - 1,
                });
                return (
                  <div key={s.period} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                    {label && (
                      <span
                        style={{
                          position: "absolute",
                          top: 0,
                          left: "50%",
                          transform: `translateX(calc(-50% + ${shift}px))`,
                          fontSize: 12,
                          lineHeight: "16px",
                          color: "var(--mute)",
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
                className="btn btn-secondary btn-sm btn-icon"
              >
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
              </button>
              <span
                style={{ fontSize: 13, lineHeight: "18px", color: "var(--sec)", minWidth: 132, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
              >
                {rangeLabel}
              </span>
              <button
                type="button"
                onClick={() => canNewer && setOffset((o) => Math.max(0, o - step))}
                disabled={!canNewer}
                aria-label="Show later periods"
                className="btn btn-secondary btn-sm btn-icon"
              >
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 13,
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
