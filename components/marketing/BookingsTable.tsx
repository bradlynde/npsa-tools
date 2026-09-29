"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { Button, Card, Note, fmtMoney } from "../ui";
import { useMedia } from "../../lib/useMedia";
import {
  CHANNEL_CHOICES,
  EXCLUSION_LABELS,
  attributionNote,
  channelLabel,
  fetchCampaignOptions,
  hostName,
  patchBooking,
  type BookingPatch,
  type BookingRow,
  type CampaignOptions,
} from "../../lib/marketing";

// Channel is a fixed width — its longest label is "Direct / Other", and letting
// it flex stole room from the two columns people actually read. Booked, Meeting,
// Held and LOE are sized to their content so the text columns get the remainder.
const COLS = "2.4fr 132px 1.9fr 76px 88px 46px 46px 128px";

/** `inset` matches the border+padding of the control sitting under the header,
 *  so the label lines up with its column's text rather than the cell edge. */
const shortDate = (d: string) =>
  new Date(d).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });

const longDate = (d: string) =>
  new Date(d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

/** A booked date on its own says little. The gap to the meeting is the part worth
 *  reading, and it is not something you want to work out by subtracting in your head. */
const leadDays = (booked: string, meeting: string | null) => {
  if (!meeting) return null;
  const days = Math.round((new Date(meeting).getTime() - new Date(booked).getTime()) / 86400000);
  return days < 0 ? null : days; // a backfilled row, not a meeting booked after it happened
};

const leadTime = (booked: string, meeting: string | null) => {
  const days = leadDays(booked, meeting);
  if (days === null) return null;
  if (days === 0) return "Booked and held the same day";
  return `Booked ${days} day${days === 1 ? "" : "s"} ahead`;
};

/** At this width and under, each booking is a card rather than a table row. */
const PHONE = "(max-width: 760px)";
/** Cards sit in the page rather than a scrolling box, so a long list is shown a
 *  page at a time instead of pushing the funnel and channels out of reach. */
const PAGE = 25;
/** A card's controls: thumb-sized, and at the 16px the phone rule in globals.css
 *  puts on every select so iOS does not zoom in. The campaign button, which that
 *  rule does not reach, is set to match. */
const CARD_CONTROL: CSSProperties = { height: 40, fontSize: 16, lineHeight: "22px" };

const HEAD: { label: string; align: "left" | "center" | "right"; inset?: number }[] = [
  { label: "Organization", align: "left" },
  { label: "Channel", align: "left", inset: 7 },
  { label: "Campaign", align: "left" },
  { label: "Booked", align: "left" },
  { label: "Meeting", align: "left" },
  { label: "Held", align: "center" },
  { label: "LOE", align: "center" },
  { label: "Counts?", align: "right", inset: 7 },
];

/**
 * Raw bookings with the manual overrides the team relies on: marking a meeting
 * Held, marking that an LOE was sent, correcting a mis-detected channel, and
 * setting a booking aside without deleting it. All write straight back to the
 * Sales Toolbox backend.
 */
export default function BookingsTable({
  rows,
  loading,
  search,
  rangeTag,
  hidden,
  onSearch,
  onChanged,
  onSaved,
  title = "Bookings",
  toolbar,
  emptyText,
  maxHeight = 460,
}: {
  rows: BookingRow[];
  loading: boolean;
  search: string;
  /** The window these rows are scoped to, matching the KPI tiles above. */
  rangeTag: string;
  /** How many bookings the window leaves out — stated rather than silently dropped. */
  hidden: number;
  onSearch: (s: string) => void;
  onChanged: (id: number, patch: Partial<BookingRow>) => void;
  /** A change landed upstream, so the figures above are now out of date. */
  onSaved?: () => void;
  title?: string;
  /** Under the header: the Marketing page puts its filters here. */
  toolbar?: React.ReactNode;
  /** Said when a filter leaves nothing to show. */
  emptyText?: string;
  maxHeight?: number | string;
}) {
  const [saving, setSaving] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The campaign picker is opened one row at a time, because filling it costs
  // several Instantly searches for that booking alone. Almost every row already
  // knows its campaign and is never asked.
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const phone = useMedia(PHONE);
  const [limit, setLimit] = useState(PAGE);
  // A new filter, search or range is a new list, so it starts from the top again.
  useEffect(() => setLimit(PAGE), [title, search, rangeTag]);

  const openPicker = async (id: number) => {
    setPickerFor(id);
    setOptions(null);
    setOptionsError(null);
    try {
      setOptions(await fetchCampaignOptions(id));
    } catch (e) {
      setOptionsError((e as Error).message);
    }
  };

  const apply = async (row: BookingRow, patch: BookingPatch, optimistic: Partial<BookingRow>) => {
    const before: Partial<BookingRow> = {};
    (Object.keys(optimistic) as (keyof BookingRow)[]).forEach((k) => {
      (before as Record<string, unknown>)[k] = row[k];
    });

    setSaving(row.id);
    setError(null);
    onChanged(row.id, optimistic);
    try {
      await patchBooking(row.id, patch);
      // Held and LOE feed the tiles above this list. Without this the two halves
      // of the same card disagree until the next full reload.
      onSaved?.();
    } catch (e) {
      onChanged(row.id, before); // roll back
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h3 className="section-title">{title}</h3>
          <span className="meta">{search ? "All time" : rangeTag.charAt(0).toUpperCase() + rangeTag.slice(1)}</span>
        </div>
        <label style={{ position: "relative", display: "block", width: phone ? "100%" : 280, maxWidth: "100%" }}>
          <Search
            size={16}
            strokeWidth={1.75}
            aria-hidden
            style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--mute)", pointerEvents: "none" }}
          />
          <input
            type="search"
            className="field"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            // At a phone's 16px the full hint runs past the field; the magnifier
            // already says what it is.
            placeholder={phone ? "Name, organization or email" : "Search name, organization or email"}
            aria-label="Search bookings"
            style={{ paddingLeft: 34 }}
          />
        </label>
      </div>

      {toolbar && <div style={{ marginBottom: 12 }}>{toolbar}</div>}

      {error && (
        <div role="alert" style={{ fontSize: 13, lineHeight: "18px", color: "var(--err-fg)", marginBottom: 10 }}>
          {error}. The change was rolled back.
        </div>
      )}

      {/* Searching deliberately leaves the window — looking a booking up by name is
          asking for that booking, not for whatever part of it falls inside 30 days. */}
      {!loading && !search && hidden > 0 && (
        <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--mute)", marginBottom: 10 }}>
          {hidden} older {hidden === 1 ? "booking is" : "bookings are"} outside this window.
          Switch to All to see every booking.
        </div>
      )}

      {loading ? (
        <Note>Loading…</Note>
      ) : rows.length === 0 ? (
        <Note>{search ? "No bookings match that search." : emptyText || `No bookings in the ${rangeTag}.`}</Note>
      ) : phone ? (
        // Phones: one card per booking instead of a table that scrolls sideways.
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.slice(0, limit).map((r) => (
              <BookingCard
                key={r.id}
                r={r}
                saving={saving === r.id}
                picking={pickerFor === r.id}
                options={options}
                optionsError={optionsError}
                onApply={(patch, optimistic) => apply(r, patch, optimistic)}
                onOpenPicker={() => openPicker(r.id)}
                onClosePicker={() => setPickerFor(null)}
              />
            ))}
          </ul>
          {rows.length > limit && (
            <Button variant="secondary" block onClick={() => setLimit((n) => n + PAGE)} style={{ marginTop: 12 }}>
              Show {Math.min(PAGE, rows.length - limit)} more
              {rows.length - limit > PAGE ? ` of ${rows.length - limit}` : ""}
            </Button>
          )}
        </>
      ) : (
        <div style={{ overflowX: "auto" }} className="table-responsive">
          <div style={{ minWidth: 916 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 12,
                padding: "10px 12px",
                borderBottom: "1px solid var(--hair)",
                // Rows reserve 3px on the left for the excluded-row marker. The
                // header needs the same reservation or every column sits off by
                // a few pixels against the values beneath it.
                borderLeft: "3px solid transparent",
              }}
            >
              {HEAD.map((h) => (
                <span
                  key={h.label}
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    lineHeight: "16px",
                    color: "var(--sec)",
                    textAlign: h.align,
                    paddingLeft: h.align === "left" ? h.inset : undefined,
                    paddingRight: h.align === "right" ? h.inset : undefined,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h.label}
                </span>
              ))}
            </div>

            <div style={{ maxHeight, overflowY: "auto" }}>
              {rows.map((r) => {
                // Excluded rows stay listed, but read as set aside rather than active.
                const excluded = Boolean(r.exclusion_reason);
                // Set aside because it moved, not because it fell through.
                const moved = r.exclusion_reason === "rescheduled" || r.rescheduled_to != null;
                const isHover = hover === r.id;
                const muted = excluded ? "var(--mute)" : "var(--sec)";
                return (
                  <div
                    key={r.id}
                    onMouseEnter={() => setHover(r.id)}
                    onMouseLeave={() => setHover(null)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: COLS,
                      gap: 12,
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--hair2)",
                      alignItems: "center",
                      background: excluded
                        ? "var(--warn-bg)"
                        : isHover
                        ? "var(--hover)"
                        : "transparent",
                      borderLeft: excluded
                        ? "3px solid var(--warn-fg)"
                        : "3px solid transparent",
                      opacity: saving === r.id ? 0.55 : 1,
                      transition: "opacity .15s, background .15s",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        title={r.organization || ""}
                        style={{
                          fontWeight: 500,
                          color: excluded ? "var(--mute)" : "var(--ink)",
                          fontSize: 14,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          // Struck through so a set-aside booking is obvious at a
                          // glance, not just slightly greyer than its neighbours.
                          textDecoration: excluded ? "line-through" : "none",
                          textDecorationThickness: excluded ? "1.5px" : undefined,
                        }}
                      >
                        {r.organization || "—"}
                      </div>
                      <div
                        style={{
                          color: "var(--mute)",
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          textDecoration: excluded ? "line-through" : "none",
                        }}
                      >
                        {r.name || ""}
                      </div>
                    </div>

                    {/* Channel is a guess, and sometimes wrong — let it be corrected. */}
                    <select
                      value={r.attribution_channel || "direct"}
                      disabled={saving === r.id}
                      onChange={(e) =>
                        apply(
                          r,
                          { channel: e.target.value },
                          { attribution_channel: e.target.value }
                        )
                      }
                      title="Attribution channel — change it if the detected one is wrong"
                      style={{
                        fontSize: 13,
                        color: muted,
                        background: "transparent",
                        border: `1px solid ${isHover ? "var(--line-strong)" : "transparent"}`,
                        borderRadius: 6,
                        padding: "3px 6px",
                        cursor: "pointer",
                        maxWidth: "100%",
                      }}
                    >
                      {CHANNEL_CHOICES.map((c) => (
                        <option key={c} value={c}>
                          {channelLabel(c)}
                        </option>
                      ))}
                    </select>

                    {/* Detection gets most of these and gives up silently on the rest,
                        which used to mean looking the church up by hand. Clicking asks
                        Instantly which campaigns could account for this booking and why,
                        so the choice is made from evidence rather than memory.

                        Hovering the text still says which rule supplied a campaign: one
                        read off the booking link and one inferred from a colleague at the
                        same domain look identical otherwise. */}
                    {pickerFor === r.id ? (
                      <select
                        autoFocus
                        value={r.instantly_campaign || ""}
                        disabled={saving === r.id}
                        onBlur={() => setPickerFor(null)}
                        onChange={(e) => {
                          const chosen = e.target.value;
                          setPickerFor(null);
                          apply(
                            r,
                            { campaign: chosen },
                            {
                              instantly_campaign: chosen || null,
                              // The server settles the channel the same way; mirroring it
                              // here stops the row flickering back for one render.
                              attribution_channel: chosen ? "instantly" : r.attribution_channel,
                            }
                          );
                        }}
                        title={
                          options && !options.configured
                            ? "Instantly is not configured, so nothing could be suggested"
                            : "Pick the campaign this booking came from"
                        }
                        style={{
                          fontSize: 13,
                          color: muted,
                          background: "var(--card)",
                          border: "1px solid var(--field)",
                          borderRadius: 6,
                          padding: "3px 6px",
                          cursor: "pointer",
                          maxWidth: "100%",
                        }}
                      >
                        <CampaignChoices options={options} optionsError={optionsError} />
                      </select>
                    ) : (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => openPicker(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") openPicker(r.id);
                        }}
                        title={
                          r.instantly_campaign
                            ? `${r.instantly_campaign}\n${attributionNote(r.attribution_source)}\n\nClick to change`
                            : `${attributionNote(r.attribution_source)}\n\nClick to find the campaign`
                        }
                        style={{
                          color: muted,
                          fontSize: 14,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          textDecoration: excluded ? "line-through" : "none",
                          cursor: "pointer",
                          borderBottom: isHover ? "1px dotted var(--field)" : "1px dotted transparent",
                        }}
                      >
                        {r.instantly_campaign ||
                          // Where a campaign is expected and missing, say what clicking does.
                          (!excluded && (!r.attribution_channel || r.attribution_channel === "direct" || r.attribution_channel === "instantly")
                            ? <span style={{ color: "var(--navy)", fontWeight: 500 }}>Find the campaign</span>
                            : "—")}
                      </span>
                    )}

                    {/* When the meeting was made, which is not when it happens. Sitting
                        next to the meeting date makes the gap between them readable at a
                        glance, and it is the date that lines up with a campaign's sends
                        when attribution is being chased down by hand. */}
                    <div
                      style={{
                        minWidth: 0,
                        fontSize: 13,
                        color: "var(--mute)",
                        fontVariantNumeric: "tabular-nums",
                        textDecoration: excluded ? "line-through" : "none",
                        cursor: r.booked_on ? "help" : undefined,
                      }}
                      title={
                        r.booked_on
                          ? [
                              longDate(r.booked_on),
                              leadTime(r.booked_on, r.meeting_date),
                              // Calendly issues a reschedule as a new booking, so this
                              // date is when the meeting was last moved. The date it was
                              // first booked is not carried onto the replacement.
                              r.rescheduled_from
                                ? "This is when the meeting was moved — the original booking date is not kept"
                                : null,
                            ]
                              .filter(Boolean)
                              .join("\n")
                          : "Calendly gave no booking date for this one"
                      }
                    >
                      {r.booked_on ? shortDate(r.booked_on) : "—"}
                    </div>

                    {/* Who took the meeting sits under its date — wanted often enough
                        to show, not often enough to spend a column on. */}
                    <div style={{ minWidth: 0, color: muted }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontVariantNumeric: "tabular-nums",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {r.meeting_date ? shortDate(r.meeting_date) : "—"}
                        {/* Calendly issues a reschedule as a new booking, so without
                            this the row is indistinguishable from first contact. */}
                        {r.rescheduled_from ? (
                          <span
                            title={`Rescheduled${
                              r.rescheduled_from_date ? ` from ${shortDate(r.rescheduled_from_date)}` : ""
                            } — the same meeting moved, not a new booking`}
                            aria-label="Rescheduled"
                            style={{ color: "var(--warn-fg)", cursor: "help", display: "inline-flex" }}
                          >
                            <RefreshCw size={13} strokeWidth={2} aria-hidden />
                          </span>
                        ) : null}
                      </div>
                      <div
                        title={r.host || ""}
                        style={{
                          fontSize: 13,
                          color: "var(--mute)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {hostName(r.host)}
                      </div>
                    </div>

                    <span style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={!!r.held}
                        disabled={saving === r.id}
                        onChange={(e) => apply(r, { held: e.target.checked }, { held: e.target.checked })}
                        aria-label={`Mark ${r.organization || "booking"} as held`}
                        style={{ cursor: "pointer", accentColor: "var(--navy)" }}
                      />
                    </span>
                    {/* A client won in Salesforce with no letter here is ticked by the
                        win, and its fee is the contract amount: the tooltip says so. */}
                    <span
                      style={{ textAlign: "center" }}
                      title={
                        r.became_client && r.fee_source === "salesforce"
                          ? `Won in Salesforce, no letter in the tool${r.fee ? ` · ${fmtMoney(r.fee)} from Salesforce` : ""}`
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!!r.became_client}
                        disabled={saving === r.id}
                        onChange={(e) =>
                          apply(
                            r,
                            { became_client: e.target.checked },
                            { became_client: e.target.checked }
                          )
                        }
                        aria-label={`Mark LOE sent for ${r.organization || "booking"}`}
                        style={{ cursor: "pointer", accentColor: "var(--navy)" }}
                      />
                    </span>

                    {/* A dropdown, not a button: there is more than one reason a booking
                        stops counting, and which one it was is worth recording. Quiet
                        until used or hovered. A Calendly cancellation is stated, not
                        offered as a choice. */}
                    <span style={{ textAlign: "right" }}>
                      {/* A moved meeting is cancelled in Calendly too, so this has to
                          be asked first — otherwise every reschedule reads as a loss. */}
                      {moved ? (
                        <span
                          className="badge badge-dot badge-warn"
                          title={`Rescheduled${
                            r.rescheduled_to_date ? ` to ${shortDate(r.rescheduled_to_date)}` : ""
                          }: counted on the replacement booking, not here`}
                          style={{ cursor: "help" }}
                        >
                          Moved
                        </span>
                      ) : r.cancelled ? (
                        <span className="badge badge-dot badge-err" title="Cancelled in Calendly">
                          Cancelled
                        </span>
                      ) : (
                        <select
                          value={r.exclusion_reason || ""}
                          disabled={saving === r.id}
                          onChange={(e) =>
                            apply(
                              r,
                              { exclusion: e.target.value },
                              { exclusion_reason: e.target.value || null }
                            )
                          }
                          title={
                            r.exclusion_reason
                              ? "Excluded from all totals — change or clear it here"
                              : "Exclude this booking from all totals, keeping it on the list"
                          }
                          style={{
                            fontSize: 13,
                            fontWeight: r.exclusion_reason ? 600 : 400,
                            color: r.exclusion_reason
                              ? "var(--warn-fg)"
                              : isHover
                              ? "var(--sec)"
                              : "var(--mute)",
                            background: r.exclusion_reason ? "var(--warn-bg)" : "transparent",
                            border: `1px solid ${
                              r.exclusion_reason
                                ? "var(--warn-fg)"
                                : isHover
                                ? "var(--line-strong)"
                                : "transparent"
                            }`,
                            borderRadius: 6,
                            padding: "3px 6px",
                            cursor: "pointer",
                            maxWidth: "100%",
                            textAlign: "right",
                          }}
                        >
                          <option value="">{r.exclusion_reason ? "Counts again" : "—"}</option>
                          {Object.entries(EXCLUSION_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** What the campaign picker offers. The table and the phone cards share it, so
 *  both ask Instantly the same question and show the same evidence. */
function CampaignChoices({
  options,
  optionsError,
}: {
  options: CampaignOptions | null;
  optionsError: string | null;
}) {
  return (
    <>
      <option value="">Leave it to detection</option>
      {!options && !optionsError && <option disabled>Searching Instantly…</option>}
      {optionsError && <option disabled>Could not reach Instantly</option>}
      {options && options.suggestions.length > 0 && (
        <optgroup label="Suggested">
          {options.suggestions.map((s) => (
            <option
              key={s.campaign_id}
              value={s.campaign}
              // The examples are what let somebody confirm a suggestion
              // rather than trust it.
              title={s.examples
                .map((x) => [x.name, x.email, x.company].filter(Boolean).join(" · "))
                .join("\n")}
            >
              {s.campaign} — {s.lead_count} lead{s.lead_count === 1 ? "" : "s"} · {s.why.join(", ")}
            </option>
          ))}
        </optgroup>
      )}
      {options && (
        <optgroup label="All campaigns">
          {options.all.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

/**
 * One booking on a phone: the table's columns as labelled lines, with the same
 * controls writing the same changes. What the table keeps in tooltips (the lead
 * time, why a campaign was picked, where a moved meeting went) is written out,
 * because a phone has no hover.
 */
function BookingCard({
  r,
  saving,
  picking,
  options,
  optionsError,
  onApply,
  onOpenPicker,
  onClosePicker,
}: {
  r: BookingRow;
  saving: boolean;
  picking: boolean;
  options: CampaignOptions | null;
  optionsError: string | null;
  onApply: (patch: BookingPatch, optimistic: Partial<BookingRow>) => void;
  onOpenPicker: () => void;
  onClosePicker: () => void;
}) {
  const excluded = Boolean(r.exclusion_reason);
  const moved = r.exclusion_reason === "rescheduled" || r.rescheduled_to != null;
  const strike = excluded ? "line-through" : "none";
  const org = r.organization || "booking";
  const host = hostName(r.host);
  const who = [r.name, host && `with ${host}`].filter(Boolean).join(" · ");
  const days = r.booked_on ? leadDays(r.booked_on, r.meeting_date) : null;
  const lead = days === null ? "" : days === 0 ? "same day" : `${days} day${days === 1 ? "" : "s"} ahead`;
  const campaignExpected =
    !excluded && (!r.attribution_channel || r.attribution_channel === "direct" || r.attribution_channel === "instantly");

  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "12px 14px",
        border: "1px solid var(--hair)",
        borderLeft: excluded ? "3px solid var(--warn-fg)" : "1px solid var(--hair)",
        borderRadius: 12,
        background: excluded ? "var(--warn-bg)" : "var(--card)",
        opacity: saving ? 0.55 : 1,
        transition: "opacity .15s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              lineHeight: "21px",
              fontWeight: 600,
              color: excluded ? "var(--mute)" : "var(--ink)",
              textDecoration: strike,
              textDecorationThickness: excluded ? "1.5px" : undefined,
              overflowWrap: "anywhere",
            }}
          >
            {r.organization || "—"}
          </div>
          {who && (
            <div className="meta" style={{ textDecoration: strike, overflowWrap: "anywhere" }}>
              {who}
            </div>
          )}
        </div>
        {moved ? (
          <span className="badge badge-dot badge-warn" style={{ flexShrink: 0 }}>
            Moved
          </span>
        ) : r.cancelled ? (
          <span className="badge badge-dot badge-err" style={{ flexShrink: 0 }}>
            Cancelled
          </span>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: "8px 10px", alignItems: "baseline" }}>
        <span className="meta">Meeting</span>
        <div style={{ minWidth: 0, fontSize: 14, lineHeight: "20px", color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
          {r.meeting_date ? shortDate(r.meeting_date) : "—"}
          {/* Calendly issues a reschedule as a new booking, so without this the
              card is indistinguishable from first contact. */}
          {r.rescheduled_from ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, lineHeight: "18px", color: "var(--warn-fg)" }}>
              <RefreshCw size={13} strokeWidth={2} aria-hidden />
              Rescheduled{r.rescheduled_from_date ? ` from ${shortDate(r.rescheduled_from_date)}` : ""}
            </div>
          ) : null}
          {moved ? (
            <div className="meta">
              Moved{r.rescheduled_to_date ? ` to ${shortDate(r.rescheduled_to_date)}` : ""}; it counts on the new booking
            </div>
          ) : null}
        </div>

        <span className="meta">Booked</span>
        <div style={{ minWidth: 0, fontSize: 14, lineHeight: "20px", color: "var(--sec)", fontVariantNumeric: "tabular-nums" }}>
          {r.booked_on ? (
            <>
              {shortDate(r.booked_on)}
              {/* On a reschedule this is when the meeting was moved: the first
                  booking date is not carried onto the replacement. */}
              {r.rescheduled_from ? " · when it was moved" : lead ? ` · ${lead}` : ""}
            </>
          ) : (
            <span className="meta">Calendly gave no date</span>
          )}
        </div>

        <span className="meta">Channel</span>
        {/* Channel is a guess, and sometimes wrong — let it be corrected. */}
        <select
          className="field field-sm"
          value={r.attribution_channel || "direct"}
          disabled={saving}
          onChange={(e) => onApply({ channel: e.target.value }, { attribution_channel: e.target.value })}
          aria-label={`Attribution channel for ${org}`}
          style={CARD_CONTROL}
        >
          {CHANNEL_CHOICES.map((c) => (
            <option key={c} value={c}>
              {channelLabel(c)}
            </option>
          ))}
        </select>

        <span className="meta">Campaign</span>
        {picking ? (
          <select
            className="field field-sm"
            autoFocus
            style={CARD_CONTROL}
            value={r.instantly_campaign || ""}
            disabled={saving}
            onBlur={onClosePicker}
            onChange={(e) => {
              const chosen = e.target.value;
              onClosePicker();
              onApply(
                { campaign: chosen },
                {
                  instantly_campaign: chosen || null,
                  // The server settles the channel the same way; mirroring it
                  // here stops the card flickering back for one render.
                  attribution_channel: chosen ? "instantly" : r.attribution_channel,
                  // The card shows why it carries its campaign, so a hand-picked one
                  // should say so now rather than after the next reload.
                  attribution_source: chosen ? "manual" : r.attribution_source,
                }
              );
            }}
            aria-label={`Campaign for ${org}`}
          >
            <CampaignChoices options={options} optionsError={optionsError} />
          </select>
        ) : (
          <button
            type="button"
            className="field field-sm"
            onClick={onOpenPicker}
            disabled={saving}
            aria-label={r.instantly_campaign ? `Campaign for ${org}: ${r.instantly_campaign}. Change it` : `Find the campaign for ${org}`}
            style={{
              ...CARD_CONTROL,
              // A long name wraps rather than trails off: there is no hover title
              // on a phone to read the rest from.
              height: "auto",
              minHeight: CARD_CONTROL.height,
              padding: "9px 10px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              textAlign: "left",
              cursor: "pointer",
              color: r.instantly_campaign ? "var(--ink)" : campaignExpected ? "var(--navy)" : "var(--mute)",
              fontWeight: !r.instantly_campaign && campaignExpected ? 500 : 400,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", textDecoration: r.instantly_campaign ? strike : "none" }}>
              {r.instantly_campaign || (campaignExpected ? "Find the campaign" : "None")}
            </span>
            <ChevronDown size={16} strokeWidth={2} aria-hidden style={{ flexShrink: 0, color: "var(--ink)" }} />
          </button>
        )}
        {/* Which rule supplied the campaign: one read off the booking link and one
            inferred from a colleague at the same domain look identical otherwise. */}
        {r.instantly_campaign && !picking ? (
          <>
            <span aria-hidden />
            <span className="meta" style={{ marginTop: -4 }}>
              {attributionNote(r.attribution_source)}
            </span>
          </>
        ) : null}

        {/* A moved or cancelled meeting says so in its badge; anything else can be
            set aside from the totals here, and put back. */}
        {!moved && !r.cancelled ? (
          <>
            <span className="meta">Counts?</span>
            <select
              className="field field-sm"
              value={r.exclusion_reason || ""}
              disabled={saving}
              onChange={(e) => onApply({ exclusion: e.target.value }, { exclusion_reason: e.target.value || null })}
              aria-label={`Whether ${org} counts toward the totals`}
              style={
                excluded
                  ? { ...CARD_CONTROL, color: "var(--warn-fg)", background: "var(--warn-bg)", borderColor: "var(--warn-fg)", fontWeight: 600 }
                  : CARD_CONTROL
              }
            >
              {/* The table's column, in the table's words: they are short enough
                  to sit in a phone-width select. */}
              <option value="">{excluded ? "Counts again" : "Yes"}</option>
              {Object.entries(EXCLUSION_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <CardTick
          label="Held"
          checked={!!r.held}
          disabled={saving}
          onChange={(on) => onApply({ held: on }, { held: on })}
          ariaLabel={`Mark ${org} as held`}
        />
        <CardTick
          label="LOE sent"
          checked={!!r.became_client}
          disabled={saving}
          onChange={(on) => onApply({ became_client: on }, { became_client: on })}
          ariaLabel={`Mark LOE sent for ${org}`}
        />
      </div>
      {/* A client won in Salesforce with no letter here is ticked by the win, and
          its fee is the contract amount. */}
      {r.became_client && r.fee_source === "salesforce" ? (
        <div className="meta" style={{ marginTop: -4 }}>
          Won in Salesforce, no letter in the tool{r.fee ? ` · ${fmtMoney(r.fee)} from Salesforce` : ""}
        </div>
      ) : null}
    </li>
  );
}

/** A tick sized for a thumb: the whole pill is the target, not just the box. */
function CardTick({
  label,
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        height: 40,
        borderRadius: 10,
        border: `1px solid ${checked ? "var(--navy)" : "var(--line-strong)"}`,
        background: checked ? "var(--navy-tint)" : "var(--card)",
        color: checked ? "var(--navy-ink)" : "var(--sec)",
        fontSize: 14,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        style={{ width: 18, height: 18, margin: 0, cursor: "inherit", accentColor: "var(--navy)" }}
      />
      {label}
    </label>
  );
}
