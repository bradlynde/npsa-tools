"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Page,
  Card,
  PageHeading,
  Eyebrow,
  StatTile,
  SegPill,
  Bar,
  Pulse,
  PillButton,
  Note,
  useRoll,
  fmtInt,
  fmtMoney,
  fmtPct,
} from "../components/ui";
import {
  fetchTimeseries,
  fetchBookings,
  totalsFor,
  priorTotalsFor,
  recentWeeks,
  weekLabel,
  channelsInRange,
  RANGE_WORD,
  BOOKINGS_LIMIT,
  loadRange,
  saveRange,
  type Range,
  type TimeseriesRow,
  type BookingRow,
} from "../lib/marketing";
import { fetchRuns, fetchPipelineStatus } from "../lib/api";
import type { RunMetadata, PipelineStatus, ScraperType } from "../lib/types";

type Metric = "booked" | "held" | "loes" | "won";

const METRICS: { key: Metric; label: string }[] = [
  { key: "booked", label: "Bookings" },
  { key: "held", label: "Held" },
  { key: "loes", label: "LOEs" },
  { key: "won", label: "Won $" },
];

const RANGES: { key: Range; label: string }[] = [
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

const todayLine = () =>
  new Date()
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    .toLowerCase();

export default function DashboardPage() {
  const router = useRouter();

  const [series, setSeries] = useState<TimeseriesRow[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [mktError, setMktError] = useState<string | null>(null);
  const [mktLoading, setMktLoading] = useState(true);

  const [range, setRange] = useState<Range>("90d");

  // Restore the last range used, then persist every change.
  useEffect(() => setRange(loadRange("90d")), []);
  const changeRange = (r: Range) => {
    setRange(r);
    saveRange(r);
  };
  const [metric, setMetric] = useState<Metric>("booked");
  const [tip, setTip] = useState(-1);

  const [activeRun, setActiveRun] = useState<RunMetadata | null>(null);
  const [activeStatus, setActiveStatus] = useState<PipelineStatus | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ts, bk] = await Promise.allSettled([fetchTimeseries(), fetchBookings()]);
      if (!alive) return;
      if (ts.status === "fulfilled") setSeries(ts.value);
      else setMktError(ts.reason?.message || "Could not load marketing data");
      if (bk.status === "fulfilled") setBookings(bk.value);
      setMktLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Find a running scrape across both backends for the strip.
  useEffect(() => {
    let alive = true;
    (async () => {
      const results = await Promise.allSettled([fetchRuns("school"), fetchRuns("church")]);
      if (!alive) return;
      const all: RunMetadata[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          all.push(
            ...r.value.map((run) => ({
              ...run,
              scraper_type: run.scraper_type || ((i === 0 ? "school" : "church") as ScraperType),
            }))
          );
        }
      });
      setActiveRun(all.find((r) => r.status === "running" || r.status === "finalizing") || null);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeRun) return;
    let alive = true;
    const poll = async () => {
      try {
        const st = await fetchPipelineStatus(activeRun.scraper_type || "school", activeRun.run_id);
        if (alive) setActiveStatus(st);
      } catch {
        /* transient — keep the last good reading */
      }
    };
    poll();
    const iv = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [activeRun]);

  const totals = useMemo(() => totalsFor(series, range), [series, range]);
  const prior = useMemo(() => priorTotalsFor(series, range), [series, range]);
  const weeks = useMemo(() => recentWeeks(series, 14), [series]);
  const channels = useMemo(() => channelsInRange(bookings, range), [bookings, range]);
  // The bookings endpoint hard-caps its result set, so a full page may mean
  // older bookings were dropped. Only relevant for the wider ranges.
  const bookingsTruncated = bookings.length >= BOOKINGS_LIMIT;

  // Counters re-roll whenever the range changes.
  const roll = useRoll(range);

  const heldRate = totals.booked ? (totals.held / totals.booked) * 100 : 0;
  const loeRate = totals.held ? Math.round((totals.loes / totals.held) * 100) : 0;
  const bookingDelta = totals.booked - prior.booked;

  // "90d" reads fine inline; "all" needs spelling out.
  const rangeTag = range === "all" ? "all time" : range;

  const stats = [
    {
      label: `bookings · ${rangeTag}`,
      value: fmtInt(totals.booked * roll),
      note:
        prior.booked > 0
          ? `${bookingDelta >= 0 ? "▲" : "▼"} ${Math.abs(bookingDelta)} vs prior period`
          : "no prior period to compare",
      accent: false,
    },
    {
      label: `held rate · ${rangeTag}`,
      value: fmtPct(heldRate * roll),
      note: `${totals.held} of ${totals.booked} booked meetings`,
      accent: false,
    },
    {
      label: `loes sent · ${rangeTag}`,
      value: fmtInt(totals.loes * roll),
      note: totals.held ? `${loeRate}% of held meetings` : "no held meetings yet",
      accent: false,
    },
    {
      label: `won revenue · ${rangeTag}`,
      value: fmtMoney(totals.wonAmount * roll),
      note: `${totals.won} opportunities · attributed to bookings`,
      accent: true,
    },
  ];

  const seriesValue = (r: TimeseriesRow): number => {
    if (metric === "booked") return Number(r.booked) || 0;
    if (metric === "held") return Number(r.held) || 0;
    if (metric === "loes") return Number(r.clients) || 0;
    return Number(r.won_amount) || 0;
  };
  const chartMax = Math.max(1, ...weeks.map(seriesValue));
  const isMoney = metric === "won";
  const chartTitle = `${
    metric === "won" ? "won revenue" : METRICS.find((m) => m.key === metric)!.label.toLowerCase()
  } by week — last ${weeks.length || 14}`;

  const stripTotal = activeStatus?.totalCounties ?? activeStatus?.total_counties ?? 0;
  const stripDone = activeStatus?.countiesProcessed ?? activeStatus?.counties_processed ?? 0;
  const stripPct = stripTotal > 0 ? Math.round((stripDone / stripTotal) * 100) : 0;
  const stripName =
    activeRun?.display_name ||
    (activeRun?.state
      ? `${activeRun.state.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())} ${
          activeRun.scraper_type === "church" ? "Churches" : "Schools"
        }`
      : "");

  return (
    <Page>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 30,
          flexWrap: "wrap",
        }}
      >
        <PageHeading eyebrow={`sales & marketing · ${todayLine()}`}>
          The business, <em>up front.</em>
        </PageHeading>
        <SegPill options={RANGES} value={range} onChange={changeRange} />
      </div>

      {mktError && (
        <Card style={{ marginBottom: 14, borderColor: "var(--err-fg)" }}>
          <Eyebrow color="var(--err-fg)" style={{ marginBottom: 6 }}>
            marketing data unavailable
          </Eyebrow>
          <div style={{ fontSize: 13.5, color: "var(--sec)" }}>
            {mktError}. The Sales Toolbox backend may be unreachable — the rest of the toolbox is
            unaffected.
          </div>
        </Card>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        {stats.map((s, i) => (
          <StatTile
            key={s.label}
            label={s.label}
            value={mktLoading ? "—" : s.value}
            note={mktLoading ? "loading…" : s.note}
            accent={s.accent}
            delay={i * 70}
          />
        ))}
      </div>

      <Card style={{ marginBottom: 14 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <Eyebrow>{chartTitle}</Eyebrow>
          <SegPill options={METRICS} value={metric} onChange={setMetric} size="sm" />
        </div>

        {weeks.length === 0 ? (
          <Note>{mktLoading ? "Loading…" : "No bookings recorded yet."}</Note>
        ) : (
          <div style={{ position: "relative" }}>
            {tip >= 0 && weeks[tip] && (
              <div
                className="mono"
                style={{
                  position: "absolute",
                  top: -6,
                  left: `${((tip + 0.5) / weeks.length) * 100}%`,
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
                {weekLabel(weeks[tip].period)} —{" "}
                {isMoney
                  ? fmtMoney(seriesValue(weeks[tip]))
                  : `${seriesValue(weeks[tip])} ${METRICS.find((m) => m.key === metric)!.label.toLowerCase()}`}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 150 }}>
              {weeks.map((w, i) => (
                <div
                  key={w.period}
                  onMouseEnter={() => setTip(i)}
                  onMouseLeave={() => setTip(-1)}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    height: "100%",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      height: `${Math.max(2, Math.round((seriesValue(w) / chartMax) * 100))}%`,
                      borderRadius: 5,
                      transformOrigin: "bottom",
                      animation: "growY .7s cubic-bezier(.34,1.4,.4,1) both",
                      transition:
                        "height .55s cubic-bezier(.34,1.3,.4,1), background .3s, filter .2s",
                      background: isMoney ? "var(--olive)" : "var(--navy)",
                      filter: tip === i ? "brightness(1.2)" : "none",
                    }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              {weeks.map((w) => (
                <div
                  key={w.period}
                  className="mono"
                  style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--faint)" }}
                >
                  {weekLabel(w.period)}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <Card>
          <Eyebrow style={{ marginBottom: 22 }}>funnel — {RANGE_WORD[range]}</Eyebrow>
          {totals.booked === 0 ? (
            <Note>{mktLoading ? "Loading…" : "No bookings in this range."}</Note>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { rn: "i.", name: "Booked", val: totals.booked, won: false },
                { rn: "ii.", name: "Held", val: totals.held, won: false },
                { rn: "iii.", name: "LOE sent", val: totals.loes, won: false },
                { rn: "iv.", name: "Won", val: totals.won, won: true },
              ].map((f) => {
                const pct = totals.booked ? Math.round((f.val / totals.booked) * 100) : 0;
                return (
                  <div
                    key={f.name}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "26px 96px 1fr 108px",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <span
                      className="serif"
                      style={{ fontStyle: "italic", fontSize: 16, color: "var(--faint)" }}
                    >
                      {f.rn}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--sec)" }}>
                      {f.name}
                    </span>
                    <Bar
                      pct={pct}
                      height={20}
                      radius={6}
                      color={f.won ? "var(--olive)" : "var(--navy)"}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        textAlign: "right",
                      }}
                    >
                      {f.val}{" "}
                      <span style={{ color: "var(--faint)", fontWeight: 500, fontSize: 11 }}>
                        {pct}%
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <Eyebrow style={{ marginBottom: bookingsTruncated ? 8 : 22 }}>
            bookings by channel — {RANGE_WORD[range]}
          </Eyebrow>
          {bookingsTruncated && (
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginBottom: 16 }}>
              Based on the most recent {BOOKINGS_LIMIT} bookings — older ones aren’t counted here.
            </div>
          )}
          {channels.length === 0 ? (
            <Note>{mktLoading ? "Loading…" : "No attributed bookings in this range."}</Note>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {channels.slice(0, 6).map((c) => (
                <div
                  key={c.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "92px 1fr 88px",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--sec)" }}>
                    {c.name}
                  </span>
                  <Bar pct={(c.booked / channels[0].booked) * 100} />
                  <span
                    style={{
                      fontSize: 12.5,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--sec)",
                      textAlign: "right",
                    }}
                  >
                    {c.booked} ·{" "}
                    <span style={{ color: "var(--olive)", fontWeight: 700 }}>
                      {c.won >= 1000 ? `$${Math.round(c.won / 1000)}k` : fmtMoney(c.won)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Scraper strip — the one place scraping appears on this page */}
      <div
        style={{
          background: "var(--navycard)",
          borderRadius: 16,
          padding: "17px 24px",
          display: "flex",
          alignItems: "center",
          gap: 18,
          boxShadow: "var(--shadow-navy)",
          flexWrap: "wrap",
        }}
      >
        {activeRun ? <Pulse /> : null}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            className="mono"
            style={{
              fontWeight: 500,
              fontSize: 11.5,
              letterSpacing: ".06em",
              color: "rgba(255,255,255,.75)",
              marginBottom: activeRun ? 7 : 0,
            }}
          >
            {activeRun ? `contact scraper — ${stripName} running` : "contact scraper — no active run"}
          </div>
          {activeRun && (
            <div style={{ height: 5, background: "rgba(255,255,255,.16)", borderRadius: 999 }}>
              <div
                style={{
                  width: `${stripPct}%`,
                  height: "100%",
                  background: "var(--olive)",
                  borderRadius: 999,
                  transformOrigin: "left",
                  animation: "growX 1s ease both",
                  transition: "width .6s cubic-bezier(.34,1.3,.4,1)",
                }}
              />
            </div>
          )}
        </div>
        {activeRun && stripTotal > 0 && (
          <span
            className="mono"
            style={{
              fontWeight: 600,
              fontSize: 12.5,
              color: "#fff",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {stripDone} / {stripTotal} · {stripPct}%
          </span>
        )}
        <PillButton tone="white" onClick={() => router.push("/scraper")} style={{ fontSize: 12.5 }}>
          Open Scraper →
        </PillButton>
      </div>
    </Page>
  );
}
