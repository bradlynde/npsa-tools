"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import TimeSeriesChart from "../components/marketing/TimeSeriesChart";
import SalesforceBand from "../components/marketing/SalesforceBand";
import CampaignTable from "../components/marketing/CampaignTable";
import BookingsTable from "../components/marketing/BookingsTable";
import {
  fetchStats,
  fetchFunnel,
  fetchTimeseries,
  fetchBookings,
  refreshEnrichment,
  totalsFor,
  priorTotalsFor,
  feesInRange,
  channelsInRange,
  campaignsInRange,
  RANGE_WORD,
  BOOKINGS_LIMIT,
  loadRange,
  saveRange,
  type Range,
  type Granularity,
  type TimeseriesRow,
  type BookingRow,
  type Stats,
  type Funnel,
} from "../lib/marketing";
import { fetchRuns, fetchPipelineStatus } from "../lib/api";
import type { RunMetadata, PipelineStatus, ScraperType } from "../lib/types";

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

  // Marketing data
  const [stats, setStats] = useState<Stats | null>(null);
  const [funnelAll, setFunnelAll] = useState<Funnel | null>(null);
  const [weekly, setWeekly] = useState<TimeseriesRow[]>([]);
  const [monthly, setMonthly] = useState<TimeseriesRow[]>([]);
  const [allBookings, setAllBookings] = useState<BookingRow[]>([]);
  const [tableRows, setTableRows] = useState<BookingRow[]>([]);
  const [mktError, setMktError] = useState<string | null>(null);
  const [mktLoading, setMktLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [range, setRange] = useState<Range>("90d");
  const [gran, setGran] = useState<Granularity>("week");
  const [search, setSearch] = useState("");

  // Scraper strip
  const [activeRun, setActiveRun] = useState<RunMetadata | null>(null);
  const [activeStatus, setActiveStatus] = useState<PipelineStatus | null>(null);

  useEffect(() => setRange(loadRange("90d")), []);
  const changeRange = (r: Range) => {
    setRange(r);
    saveRange(r);
  };

  const loadMarketing = useCallback(async () => {
    const [s, f, w, b] = await Promise.allSettled([
      fetchStats(),
      fetchFunnel(),
      fetchTimeseries("week"),
      fetchBookings(),
    ]);
    if (s.status === "fulfilled") setStats(s.value);
    if (f.status === "fulfilled") setFunnelAll(f.value);
    if (w.status === "fulfilled") setWeekly(w.value);
    else setMktError((w.reason as Error)?.message || "Could not load marketing data");
    if (b.status === "fulfilled") {
      setAllBookings(b.value);
      setTableRows(b.value);
    }
    setMktLoading(false);
  }, []);

  useEffect(() => {
    loadMarketing();
  }, [loadMarketing]);

  // Monthly series is only fetched when the chart is switched to months.
  useEffect(() => {
    if (gran !== "month" || monthly.length > 0) return;
    fetchTimeseries("month")
      .then(setMonthly)
      .catch(() => setMonthly([]));
  }, [gran, monthly.length]);

  // Search re-queries the table only; the aggregates keep using the full set.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!search) {
        setTableRows(allBookings);
        return;
      }
      fetchBookings(search)
        .then(setTableRows)
        .catch(() => setTableRows([]));
    }, 300);
    return () => clearTimeout(t);
  }, [search, allBookings]);

  // Scraper strip — find a run in flight across both backends.
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

  const handleRefresh = async () => {
    setRefreshing(true);
    setMktError(null);
    try {
      await refreshEnrichment();
      await loadMarketing();
    } catch (e) {
      setMktError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  /* ── Derived ────────────────────────────────────────────────── */

  const totals = useMemo(() => totalsFor(weekly, range), [weekly, range]);
  const prior = useMemo(() => priorTotalsFor(weekly, range), [weekly, range]);
  const channels = useMemo(() => channelsInRange(allBookings, range), [allBookings, range]);
  const campaigns = useMemo(() => campaignsInRange(allBookings, range), [allBookings, range]);
  const bookingsTruncated = allBookings.length >= BOOKINGS_LIMIT;

  // LOE fee value: the time series has no fees, so it comes from bookings —
  // except all-time, where the funnel endpoint gives an uncapped figure.
  const loeValue = useMemo(
    () => (range === "all" && funnelAll ? funnelAll.fees : feesInRange(allBookings, range)),
    [range, funnelAll, allBookings]
  );

  const roll = useRoll(range);
  const heldRate = totals.booked ? (totals.held / totals.booked) * 100 : 0;
  const loeRate = totals.held ? Math.round((totals.loes / totals.held) * 100) : 0;
  const bookingDelta = totals.booked - prior.booked;
  const rangeTag = range === "all" ? "all time" : range;
  const mom = stats ? stats.bookings_this_month - stats.bookings_last_month : 0;

  const primaryStats = [
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

  const applyBookingChange = (id: number, field: "held" | "became_client", value: boolean) => {
    const patch = (rows: BookingRow[]) =>
      rows.map((r) => (r.id === id ? { ...r, [field]: value } : r));
    setTableRows(patch);
    setAllBookings(patch);
  };

  return (
    <Page>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 26,
          flexWrap: "wrap",
        }}
      >
        <PageHeading eyebrow={`sales & marketing · ${todayLine()}`}>
          The business, <em>up front.</em>
        </PageHeading>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SegPill options={RANGES} value={range} onChange={changeRange} />
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="mono"
            style={{
              fontWeight: 600,
              fontSize: 12,
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid var(--bd2)",
              background: "transparent",
              color: "var(--sec)",
              cursor: refreshing ? "wait" : "pointer",
              transition: "background .2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {refreshing ? "refreshing…" : "↻ refresh data"}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: ".06em",
            color: "var(--mute)",
            background: "var(--seg)",
            border: "1px solid var(--hair)",
            padding: "4px 12px",
            borderRadius: 999,
          }}
        >
          funnel tracked since Feb 2026
        </span>
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

      {/* Primary, range-scoped KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        {primaryStats.map((s, i) => (
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

      {/* Fixed-window pulse — these don't move with the range selector */}
      {stats && (
        <Card style={{ marginBottom: 14, padding: "16px 22px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
              gap: 18,
            }}
          >
            {[
              {
                label: "bookings this week",
                value: fmtInt(stats.bookings_this_week),
                note: "sun–sat",
                accent: false,
              },
              {
                label: "bookings this month",
                value: fmtInt(stats.bookings_this_month),
                note: `${mom >= 0 ? "+" : ""}${mom} vs last month`,
                accent: false,
              },
              {
                label: "from instantly",
                value: fmtPct(stats.instantly_pct * 100),
                note: "of all bookings",
                accent: false,
              },
              {
                label: "loe value won",
                value: fmtMoney(stats.total_fees_won),
                note: "all signed letters",
                accent: true,
              },
            ].map((s) => (
              <div key={s.label}>
                <div
                  className="mono"
                  style={{
                    fontWeight: 500,
                    fontSize: 10.5,
                    letterSpacing: ".07em",
                    color: "var(--mute)",
                    marginBottom: 7,
                  }}
                >
                  {s.label}
                </div>
                <div
                  className="serif"
                  style={{
                    fontSize: 24,
                    fontWeight: 500,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                    color: s.accent ? "var(--olive)" : "var(--ink)",
                  }}
                >
                  {s.value}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>{s.note}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Salesforce revenue layer */}
      {stats && <SalesforceBand stats={stats} />}

      {/* Time series */}
      <TimeSeriesChart
        series={gran === "week" ? weekly : monthly}
        gran={gran}
        onGranChange={setGran}
        loading={mktLoading}
      />

      {/* Funnel + channels */}
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
                { rn: "i.", name: "Booked", val: totals.booked, won: false, foot: "" },
                { rn: "ii.", name: "Held", val: totals.held, won: false, foot: "" },
                {
                  rn: "iii.",
                  name: "LOE sent",
                  val: totals.loes,
                  won: false,
                  foot: loeValue ? `${fmtMoney(loeValue)} in LOE value` : "",
                },
                {
                  rn: "iv.",
                  name: "Won",
                  val: totals.won,
                  won: true,
                  foot: totals.wonAmount ? `${fmtMoney(totals.wonAmount)} in revenue` : "",
                },
              ].map((f) => {
                const pct = totals.booked ? Math.round((f.val / totals.booked) * 100) : 0;
                return (
                  <div key={f.name}>
                    <div
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
                    {f.foot && (
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: "var(--olive)",
                          marginTop: 5,
                          paddingLeft: 134,
                        }}
                      >
                        {f.foot}
                      </div>
                    )}
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
              {channels.map((c) => (
                <div
                  key={c.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "104px 1fr 104px",
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
                    {c.booked}
                    {c.loes ? ` · ${c.loes} LOE` : ""}
                    {c.won ? (
                      <>
                        {" · "}
                        <span style={{ color: "var(--olive)", fontWeight: 700 }}>
                          {c.won >= 1000 ? `$${Math.round(c.won / 1000)}k` : fmtMoney(c.won)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* By campaign & source */}
      <CampaignTable rows={campaigns} rangeWord={RANGE_WORD[range]} loading={mktLoading} />

      {/* Raw bookings, with the Held / LOE overrides */}
      <BookingsTable
        rows={tableRows}
        loading={mktLoading}
        search={search}
        onSearch={setSearch}
        onChanged={applyBookingChange}
      />

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
