"use client";

import { useState } from "react";
import { Card, Eyebrow, Note } from "../ui";
import {
  CHANNEL_CHOICES,
  EXCLUSION_LABELS,
  channelLabel,
  hostName,
  patchBooking,
  type BookingPatch,
  type BookingRow,
} from "../../lib/marketing";

// Channel is a fixed width — its longest label is "Direct / Other", and letting
// it flex stole room from the two columns people actually read. Meeting, Held
// and LOE are sized to their content so the text columns get the remainder.
const COLS = "2.4fr 132px 1.9fr 88px 46px 46px 128px";

/** `inset` matches the border+padding of the control sitting under the header,
 *  so the label lines up with its column's text rather than the cell edge. */
const HEAD: { label: string; align: "left" | "center" | "right"; inset?: number }[] = [
  { label: "ORG / NAME", align: "left" },
  { label: "CHANNEL", align: "left", inset: 7 },
  { label: "CAMPAIGN", align: "left" },
  { label: "MEETING", align: "left" },
  { label: "HELD", align: "center" },
  { label: "LOE", align: "center" },
  { label: "COUNTS?", align: "right", inset: 7 },
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
  onSearch,
  onChanged,
}: {
  rows: BookingRow[];
  loading: boolean;
  search: string;
  onSearch: (s: string) => void;
  onChanged: (id: number, patch: Partial<BookingRow>) => void;
}) {
  const [saving, setSaving] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <Eyebrow>bookings</Eyebrow>
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name, org or email"
          aria-label="Search bookings"
          style={{
            font: "inherit",
            fontSize: 13,
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid var(--bd2)",
            background: "var(--card)",
            color: "var(--ink)",
            width: 240,
            maxWidth: "100%",
          }}
        />
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: "var(--err-fg)", marginBottom: 10 }}>
          {error} — the change was rolled back.
        </div>
      )}

      {loading ? (
        <Note>Loading…</Note>
      ) : rows.length === 0 ? (
        <Note>{search ? "No bookings match that search." : "No bookings yet."}</Note>
      ) : (
        <div style={{ overflowX: "auto" }} className="table-responsive">
          <div style={{ minWidth: 840 }}>
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
                  className="mono"
                  style={{
                    fontWeight: 600,
                    fontSize: 10.5,
                    letterSpacing: ".07em",
                    color: "var(--faint)",
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

            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {rows.map((r) => {
                // Excluded rows stay listed, but read as set aside rather than active.
                const excluded = Boolean(r.exclusion_reason);
                const isHover = hover === r.id;
                const muted = excluded ? "var(--faint)" : "var(--sec)";
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
                          fontWeight: 600,
                          color: excluded ? "var(--faint)" : "var(--ink)",
                          fontSize: 13.5,
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
                          color: "var(--faint)",
                          fontSize: 12,
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
                        font: "inherit",
                        fontSize: 12.5,
                        color: muted,
                        background: "transparent",
                        border: `1px solid ${isHover ? "var(--bd2)" : "transparent"}`,
                        borderRadius: 999,
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

                    <span
                      title={r.instantly_campaign || ""}
                      style={{
                        color: muted,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textDecoration: excluded ? "line-through" : "none",
                      }}
                    >
                      {r.instantly_campaign || "—"}
                    </span>

                    {/* Who took the meeting sits under its date — wanted often enough
                        to show, not often enough to spend a column on. */}
                    <div style={{ minWidth: 0, color: muted }}>
                      <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                        {r.meeting_date
                          ? new Date(r.meeting_date).toLocaleDateString("en-US", {
                              month: "numeric",
                              day: "numeric",
                              year: "2-digit",
                            })
                          : "—"}
                      </div>
                      <div
                        title={r.host || ""}
                        style={{
                          fontSize: 11.5,
                          color: "var(--faint)",
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
                        style={{ cursor: "pointer", accentColor: "var(--olive)" }}
                      />
                    </span>

                    {/* A dropdown, not a button: there is more than one reason a booking
                        stops counting, and which one it was is worth recording. Quiet
                        until used or hovered. A Calendly cancellation is stated, not
                        offered as a choice. */}
                    <span style={{ textAlign: "right" }}>
                      {r.cancelled ? (
                        <span
                          className="mono"
                          title="Cancelled in Calendly"
                          style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            letterSpacing: ".05em",
                            color: "var(--err-fg)",
                            background: "var(--err-bg)",
                            border: "1px solid var(--err-fg)",
                            borderRadius: 999,
                            padding: "3px 9px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          CANCELLED
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
                            font: "inherit",
                            fontSize: 11.5,
                            fontWeight: r.exclusion_reason ? 700 : 500,
                            color: r.exclusion_reason
                              ? "var(--warn-fg)"
                              : isHover
                              ? "var(--sec)"
                              : "var(--faint)",
                            background: r.exclusion_reason ? "var(--warn-bg)" : "transparent",
                            border: `1px solid ${
                              r.exclusion_reason
                                ? "var(--warn-fg)"
                                : isHover
                                ? "var(--bd2)"
                                : "transparent"
                            }`,
                            borderRadius: 999,
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
