"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Page,
  Card,
  PageHeading,
  SectionHeader,
  Eyebrow,
  StatTile,
  SegPill,
  ChipRow,
  Bar,
  Button,
  Note,
  useRoll,
  fmtInt,
  fmtMoney,
  fmtPct,
} from "../../components/ui";
import TimeSeriesChart from "../../components/marketing/TimeSeriesChart";
import CampaignTable from "../../components/marketing/CampaignTable";
import BookingsTable from "../../components/marketing/BookingsTable";
import {
  fetchStats,
  fetchFunnel,
  fetchTimeseries,
  fetchBookings,
  refreshEnrichment,
  bookingsInRange,
  totalsFor,
  priorTotalsFor,
  feesInRange,
  channelsInRange,
  campaignsInRange,
  RANGE_WORD,
  priorWindow,
  windowLabel,
  BOOKINGS_LIMIT,
  loadRange,
  saveRange,
  type Range,
  type Granularity,
  type TimeseriesRow,
  type BookingRow,
  type Stats,
  type Funnel,
} from "../../lib/marketing";

const RANGES: { key: Range; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "quarter", label: "Quarter" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

/** "this quarter" → "This quarter" for section meta. */
const sentenceWord = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/* ── The bookings list's filters: the work that comes back every week ── */

type Show = "all" | "attribution" | "followup" | "upcoming";

/** Set aside or cancelled: listed, but nothing to chase. */
const setAside = (b: BookingRow) => Boolean(b.exclusion_reason) || Boolean(b.cancelled) || b.rescheduled_to != null;

/**
 * No channel, or the catch-all, or Instantly without a campaign: somebody has
 * to say where this booking came from.
 */
const needsAttribution = (b: BookingRow) => {
  if (setAside(b)) return false;
  const ch = (b.attribution_channel || "").trim();
  return !ch || ch === "direct" || (ch === "instantly" && !b.instantly_campaign);
};

/** The meeting happened and no LOE has gone out yet: the follow-up list. */
const heldNoLoe = (b: BookingRow) => !setAside(b) && Boolean(b.held) && !b.became_client;

const upcoming = (b: BookingRow) => !setAside(b) && Boolean(b.meeting_date) && new Date(b.meeting_date as string).getTime() > Date.now();

const FILTER: Record<Show, (b: BookingRow) => boolean> = {
  all: () => true,
  attribution: needsAttribution,
  followup: heldNoLoe,
  upcoming,
};

const LIST_TITLE: Record<Show, string> = {
  all: "Bookings",
  attribution: "Needs attribution",
  followup: "Held, no LOE yet",
  upcoming: "Upcoming",
};

const EMPTY: Record<Show, string> = {
  all: "",
  attribution: "Every booking in this range has a source. Nothing to attribute.",
  followup: "No held meetings are waiting on an LOE in this range.",
  upcoming: "No meetings coming up in this range.",
};

/**
 * Marketing: what feeds the pipeline. The figures, the chart, every booking with
 * where it came from, then the funnel, channels and campaigns those bookings add
 * up to. Attribution lives here because it moves these numbers: correct a
 * booking's channel and the channel figures below change with it.
 *
 * One date range covers the whole page. The sales figures are all-time from
 * Salesforce, which is why they have a page of their own (the Company Report).
 */
export default function MarketingPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [funnelAll, setFunnelAll] = useState<Funnel | null>(null);
  const [weekly, setWeekly] = useState<TimeseriesRow[]>([]);
  const [monthly, setMonthly] = useState<TimeseriesRow[]>([]);
  // Daily, for the range totals: only days can be cut to a calendar window exactly.
  const [daily, setDaily] = useState<TimeseriesRow[]>([]);
  const [allBookings, setAllBookings] = useState<BookingRow[]>([]);
  const [tableRows, setTableRows] = useState<BookingRow[]>([]);
  const [mktError, setMktError] = useState<string | null>(null);
  const [mktLoading, setMktLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [range, setRange] = useState<Range>("quarter");
  const [gran, setGran] = useState<Granularity>("week");
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const aggregateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setRange(loadRange("quarter")), []);
  const changeRange = (r: Range) => {
    setRange(r);
    saveRange(r);
  };

  const loadMarketing = useCallback(async () => {
    const [s, f, w, b, d] = await Promise.allSettled([
      fetchStats(),
      fetchFunnel(),
      fetchTimeseries("week"),
      fetchBookings(),
      fetchTimeseries("day"),
    ]);
    if (s.status === "fulfilled") setStats(s.value);
    if (f.status === "fulfilled") setFunnelAll(f.value);
    if (w.status === "fulfilled") setWeekly(w.value);
    else setMktError((w.reason as Error)?.message || "Could not load marketing data");
    if (d.status === "fulfilled") setDaily(d.value);
    else setMktError((d.reason as Error)?.message || "Could not load marketing data");
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

  // Search re-queries the list only; the figures keep using the full set.
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

  // The list is scoped to the same window as the figures above it. Search is the
  // exception: it is a request for a specific booking, not for a slice of them.
  const inRange = useMemo(
    () => (search ? tableRows : bookingsInRange(tableRows, range)),
    [tableRows, range, search]
  );
  const counts = useMemo(
    () => ({
      all: inRange.length,
      attribution: inRange.filter(needsAttribution).length,
      followup: inRange.filter(heldNoLoe).length,
      upcoming: inRange.filter(upcoming).length,
    }),
    [inRange]
  );
  const visibleRows = useMemo(() => inRange.filter(FILTER[show]), [inRange, show]);

  const totals = useMemo(() => totalsFor(daily, range), [daily, range]);
  const prior = useMemo(() => priorTotalsFor(daily, range), [daily, range]);
  const priorLabel = windowLabel(priorWindow(range) ?? { from: null, to: null });
  const channels = useMemo(() => channelsInRange(allBookings, range), [allBookings, range]);
  const campaigns = useMemo(() => campaignsInRange(allBookings, range), [allBookings, range]);
  const bookingsTruncated = allBookings.length >= BOOKINGS_LIMIT;

  // LOE fee value: the time series has no fees, so it comes from bookings —
  // except all-time, where the funnel endpoint gives an uncapped figure.
  const loeValue = useMemo(
    () => (range === "all" && funnelAll ? funnelAll.fees : feesInRange(allBookings, range)),
    [range, funnelAll, allBookings]
  );

  // Re-run once the data lands, not just on mount — otherwise the counters
  // finish rolling against zeroes and the numbers appear with no animation.
  const roll = useRoll(mktLoading ? "loading" : `${range}-${daily.length}`);
  const upcomingCount = Math.max(0, totals.booked - totals.resolved);
  const loeRate = totals.held ? Math.round((totals.loes / totals.held) * 100) : 0;
  const bookingDelta = totals.booked - prior.booked;
  const rangeTag = RANGE_WORD[range];
  // This month so far against last month up to the same day, not against all of it.
  const monthWin = priorWindow("month");
  const monthPrior = windowLabel(monthWin ?? { from: null, to: null });
  const lastMonthName = monthWin?.from
    ? new Date(`${monthWin.from}T12:00:00`).toLocaleDateString("en-US", { month: "short" })
    : "last month";
  const mom = stats
    ? stats.bookings_this_month - (stats.bookings_last_month_to_date ?? stats.bookings_last_month)
    : 0;

  const primaryStats = [
    {
      label: `bookings · ${rangeTag}`,
      value: fmtInt(totals.booked * roll),
      note:
        prior.booked > 0
          ? `${bookingDelta >= 0 ? "▲" : "▼"} ${Math.abs(bookingDelta)} vs ${priorLabel}`
          : "no prior period to compare",
      accent: false,
    },
    // No held-rate tile. The Held box ticks itself once a meeting has passed and was
    // not cancelled, which makes it a useful marker in the bookings list — that one
    // is done — but a hopeless basis for a rate. It derives from Calendly's no_show,
    // which only a person sets and nobody here does, so the box is ticked for every
    // past meeting and the rate read 100% of 232 with no input that could lower it.
    // Attendance is not measured anywhere, so it is not reported as though it were.
    {
      label: `LOEs sent · ${rangeTag}`,
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

  const applyBookingChange = (id: number, patch: Partial<BookingRow>) => {
    const merge = (rows: BookingRow[]) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setTableRows(merge);
    setAllBookings(merge);
  };

  /**
   * Ticking Held or LOE on a row changes what the figures above it say, but those
   * come from the aggregate endpoints rather than from these rows — so without
   * re-reading them the two halves of the same view disagree until a full reload.
   *
   * Debounced because working down a column of checkboxes is the normal way to
   * use this list, and each tick would otherwise fire its own round trip.
   */
  const refreshAggregates = useCallback(() => {
    if (aggregateTimer.current) clearTimeout(aggregateTimer.current);
    aggregateTimer.current = setTimeout(() => {
      fetchTimeseries("week").then(setWeekly).catch(() => {});
      fetchTimeseries("day").then(setDaily).catch(() => {});
      fetchStats().then(setStats).catch(() => {});
      fetchFunnel().then(setFunnelAll).catch(() => {});
      // Only refreshed if it has already been loaded — switching to months fetches it.
      setMonthly((m) => {
        if (m.length) fetchTimeseries("month").then(setMonthly).catch(() => {});
        return m;
      });
    }, 700);
  }, []);

  useEffect(() => () => {
    if (aggregateTimer.current) clearTimeout(aggregateTimer.current);
  }, []);

  return (
    <Page>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          marginBottom: 28,
          flexWrap: "wrap",
        }}
      >
        <PageHeading description="Every consultation booked through Calendly, where it came from, and what it turned into. Tracked since February 2026.">
          Marketing
        </PageHeading>
        {/* One range for the whole page, so it sits with the title rather than a section. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SegPill options={RANGES} value={range} onChange={changeRange} size="sm" label="Date range" />
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={handleRefresh} busy={refreshing} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh data"}
          </Button>
        </div>
      </div>

      {mktError && (
        <Card style={{ marginBottom: 16, borderColor: "var(--err-line)", background: "var(--err-bg)" }}>
          <Eyebrow color="var(--err-fg)" style={{ marginBottom: 4, fontWeight: 600 }}>
            Marketing data unavailable
          </Eyebrow>
          <div style={{ fontSize: 14, lineHeight: "20px", color: "var(--sec)" }}>
            {mktError}. The Sales Toolbox backend may be unreachable. The rest of the toolbox is unaffected.
          </div>
        </Card>
      )}

      {/* Primary, range-scoped figures */}
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
                label: "Bookings this week",
                value: fmtInt(stats.bookings_this_week),
                note: "Sunday to Saturday",
                accent: false,
              },
              {
                label: "Bookings this month",
                value: fmtInt(stats.bookings_this_month),
                note:
                  stats.bookings_last_month_to_date != null
                    ? `${mom >= 0 ? "▲" : "▼"} ${Math.abs(mom)} vs ${monthPrior} · ${lastMonthName} total ${stats.bookings_last_month}`
                    : `${mom >= 0 ? "+" : ""}${mom} vs last month`,
                accent: false,
              },
              {
                label: "From Instantly",
                value: fmtPct(stats.instantly_pct * 100),
                note: "Of all bookings",
                accent: false,
              },
              {
                label: "LOE value won",
                value: fmtMoney(stats.total_fees_won),
                // The fees on booked calls that became clients, not every letter
                // ever signed: the backend sums them from bookings.
                note: "All time, from booked calls",
                accent: true,
              },
            ].map((s) => (
              <div key={s.label}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  {s.label}
                </div>
                <div
                  className="serif"
                  style={{
                    fontSize: 24,
                    fontWeight: 500,
                    lineHeight: "32px",
                    fontVariantNumeric: "tabular-nums",
                    color: s.accent ? "var(--olive)" : "var(--ink)",
                  }}
                >
                  {s.value}
                </div>
                <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--mute)", marginTop: 4 }}>{s.note}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Sits directly under the figures it qualifies, and above the charts that
          inherit the same exclusions. */}
      {stats?.excluded?.length ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 0 16px",
            fontSize: 13,
            lineHeight: "18px",
            color: "var(--mute)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--bd2)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          />
          <span>
            Excluded from these figures:{" "}
            {stats.excluded.map((e) => `${e.total} ${e.label.toLowerCase()}`).join(" · ")}
            {(stats.excluded_this_week || 0) > 0 && (
              <strong style={{ color: "var(--sec)", fontWeight: 600 }}>
                {" "}
                ({stats.excluded_this_week} this week)
              </strong>
            )}
            <span> · still listed below</span>
          </span>
        </div>
      ) : null}

      {/* Time series */}
      <TimeSeriesChart
        series={gran === "week" ? weekly : monthly}
        gran={gran}
        onGranChange={setGran}
        loading={mktLoading}
      />

      {/* Raw bookings first — the source rows people check before the roll-ups */}
      <BookingsTable
        title={LIST_TITLE[show]}
        rows={visibleRows}
        loading={mktLoading}
        search={search}
        rangeTag={rangeTag}
        hidden={search ? 0 : tableRows.length - inRange.length}
        onSearch={setSearch}
        onChanged={applyBookingChange}
        onSaved={refreshAggregates}
        emptyText={EMPTY[show] || undefined}
        maxHeight="min(70vh, 760px)"
        toolbar={
          <ChipRow<Show>
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              { key: "all", label: `All · ${counts.all}` },
              { key: "attribution", label: `Needs attribution · ${counts.attribution}` },
              { key: "followup", label: `Held, no LOE yet · ${counts.followup}` },
              { key: "upcoming", label: `Upcoming · ${counts.upcoming}` },
            ]}
          />
        }
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
          <SectionHeader title="Funnel" meta={sentenceWord(rangeTag)} style={{ marginBottom: 20 }} />
          {totals.booked === 0 ? (
            <Note>{mktLoading ? "Loading…" : "No bookings in this range."}</Note>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { rn: "i.", name: "Booked", val: totals.booked, won: false, foot: "" },
                {
                  rn: "ii.",
                  name: "Held",
                  val: totals.held,
                  won: false,
                  // The funnel measures every stage against Booked, so this share
                  // counts meetings still to come as not-yet-held. Saying how many
                  // stops it reading as a drop-off it is not.
                  foot: upcomingCount ? `${upcomingCount} still to come` : "",
                },
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
                        style={{ fontStyle: "italic", fontSize: 16, color: "var(--mute)" }}
                      >
                        {f.rn}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
                        {f.name}
                      </span>
                      <Bar
                        pct={pct}
                        height={16}
                        radius={4}
                        color={f.won ? "var(--olive)" : "var(--navy)"}
                      />
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                          textAlign: "right",
                        }}
                      >
                        {f.val}{" "}
                        <span style={{ color: "var(--mute)", fontWeight: 400, fontSize: 13 }}>
                          {pct}%
                        </span>
                      </span>
                    </div>
                    {f.foot && (
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: "var(--olive-ink)",
                          marginTop: 4,
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
          <SectionHeader
            title="Bookings by channel"
            meta={sentenceWord(rangeTag)}
            style={{ marginBottom: bookingsTruncated ? 6 : 20 }}
          />
          {bookingsTruncated && (
            <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--mute)", marginBottom: 16 }}>
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
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
                    {c.name}
                  </span>
                  <Bar pct={(c.booked / channels[0].booked) * 100} />
                  <span
                    style={{
                      fontSize: 13,
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
                        <span style={{ color: "var(--olive-ink)", fontWeight: 600 }}>
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
      <CampaignTable rows={campaigns} rangeWord={rangeTag} loading={mktLoading} />
    </Page>
  );
}
