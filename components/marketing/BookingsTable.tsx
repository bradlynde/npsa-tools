"use client";

import { useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Card, Note } from "../ui";
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
const leadTime = (booked: string, meeting: string | null) => {
  if (!meeting) return null;
  const days = Math.round((new Date(meeting).getTime() - new Date(booked).getTime()) / 86400000);
  if (days < 0) return null; // a backfilled row, not a meeting booked after it happened
  if (days === 0) return "Booked and held the same day";
  return `Booked ${days} day${days === 1 ? "" : "s"} ahead`;
};

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
        <label style={{ position: "relative", display: "block", width: 280, maxWidth: "100%" }}>
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
            placeholder="Search name, organization or email"
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
                                {s.campaign} — {s.lead_count} lead{s.lead_count === 1 ? "" : "s"} ·{" "}
                                {s.why.join(", ")}
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
                    <span style={{ textAlign: "center" }}>
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
