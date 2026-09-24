"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Page, PageHeading, SegPill, ChipRow } from "../../components/ui";
import BookingsTable from "../../components/marketing/BookingsTable";
import {
  fetchBookings,
  bookingsInRange,
  RANGE_WORD,
  loadRange,
  saveRange,
  type BookingRow,
  type Range,
} from "../../lib/marketing";

const RANGES: { key: Range; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "quarter", label: "Quarter" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

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

const EMPTY: Record<Show, string> = {
  all: "",
  attribution: "Every booking in this range has a source. Nothing to attribute.",
  followup: "No held meetings are waiting on an LOE in this range.",
  upcoming: "No meetings coming up in this range.",
};

/**
 * Booking attribution, on its own page: every Calendly booking with where it
 * came from, the Held and LOE marks, and the filters for the work that recurs.
 * The same table sits on the Dashboard; this is the place to work through it.
 */
export default function BookingsPage() {
  const [allBookings, setAllBookings] = useState<BookingRow[]>([]);
  const [tableRows, setTableRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("quarter");
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");

  useEffect(() => setRange(loadRange("quarter")), []);
  const changeRange = (r: Range) => {
    setRange(r);
    saveRange(r);
  };

  useEffect(() => {
    let live = true;
    fetchBookings()
      .then((b) => {
        if (!live) return;
        setAllBookings(b);
        setTableRows(b);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  // Search re-queries the backend, as on the Dashboard.
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

  // Searching leaves the window, as it does on the Dashboard: looking a booking
  // up by name is asking for that booking, whenever it was.
  const inRange = useMemo(() => (search ? tableRows : bookingsInRange(tableRows, range)), [tableRows, range, search]);
  const counts = useMemo(
    () => ({
      all: inRange.length,
      attribution: inRange.filter(needsAttribution).length,
      followup: inRange.filter(heldNoLoe).length,
      upcoming: inRange.filter(upcoming).length,
    }),
    [inRange]
  );
  const visible = useMemo(() => inRange.filter(FILTER[show]), [inRange, show]);

  const applyBookingChange = useCallback((id: number, patch: Partial<BookingRow>) => {
    const merge = (rows: BookingRow[]) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setTableRows(merge);
    setAllBookings(merge);
  }, []);

  return (
    <Page>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <PageHeading description="Every consultation booked through Calendly and where it came from. Correct a channel or campaign, and mark meetings held and LOEs sent.">
          Bookings
        </PageHeading>
        <SegPill options={RANGES} value={range} onChange={changeRange} size="sm" label="Bookings range" />
      </div>

      {error && (
        <div role="alert" style={{ marginBottom: 16, padding: "12px 16px", borderRadius: "var(--r-md)", border: "1px solid var(--err-line)", background: "var(--err-bg)", color: "var(--err-fg)", fontSize: 14 }}>
          Could not load bookings: {error}. The Sales Toolbox backend may be unreachable.
        </div>
      )}

      <BookingsTable
        title={show === "all" ? "All bookings" : show === "attribution" ? "Needs attribution" : show === "followup" ? "Held, no LOE yet" : "Upcoming"}
        rows={visible}
        loading={loading}
        search={search}
        rangeTag={RANGE_WORD[range]}
        hidden={search ? 0 : tableRows.length - inRange.length}
        onSearch={setSearch}
        onChanged={applyBookingChange}
        emptyText={EMPTY[show] || undefined}
        maxHeight="min(70vh, 900px)"
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

      <p className="meta" style={{ marginTop: 4 }}>
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--navy)", textDecoration: "none", fontWeight: 500 }}>
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> Funnel, channels and campaigns are on the Dashboard
        </Link>
      </p>
    </Page>
  );
}
