"use client";

import { useState } from "react";
import { Card, Eyebrow, Note } from "../ui";
import { channelLabel, patchBooking, type BookingRow } from "../../lib/marketing";

const COLS = "2fr 1.3fr 1.5fr 1fr 70px 70px";

/**
 * Raw bookings with the two manual overrides the team relies on: marking a
 * meeting Held and marking that an LOE was sent. Both write straight back to
 * the Sales Toolbox backend.
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
  onChanged: (id: number, field: "held" | "became_client", value: boolean) => void;
}) {
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (id: number, field: "held" | "became_client", value: boolean) => {
    setSaving(id);
    setError(null);
    onChanged(id, field, value); // optimistic
    try {
      await patchBooking(id, field, value);
    } catch (e) {
      onChanged(id, field, !value); // roll back
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
          <div style={{ minWidth: 720 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 12,
                padding: "10px 12px",
                borderBottom: "1px solid var(--hair)",
              }}
            >
              {["ORG / NAME", "CHANNEL", "CAMPAIGN", "MEETING", "HELD", "LOE"].map((h, i) => (
                <span
                  key={h}
                  className="mono"
                  style={{
                    fontWeight: 600,
                    fontSize: 10.5,
                    letterSpacing: ".07em",
                    color: "var(--faint)",
                    textAlign: i >= 4 ? "center" : "left",
                  }}
                >
                  {h}
                </span>
              ))}
            </div>

            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {rows.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: COLS,
                    gap: 12,
                    padding: "11px 12px",
                    borderBottom: "1px solid var(--hair2)",
                    alignItems: "center",
                    opacity: saving === r.id ? 0.55 : 1,
                    transition: "opacity .15s, background .15s",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        color: "var(--ink)",
                        fontSize: 13.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
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
                      }}
                    >
                      {r.name || ""}
                    </div>
                  </div>
                  <span style={{ color: "var(--sec)", fontSize: 13 }}>
                    {channelLabel(r.attribution_channel)}
                  </span>
                  <span
                    style={{
                      color: "var(--sec)",
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.instantly_campaign || "—"}
                  </span>
                  <span
                    style={{
                      color: "var(--sec)",
                      fontSize: 13,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.meeting_date ? new Date(r.meeting_date).toLocaleDateString("en-US") : "—"}
                  </span>
                  <span style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={!!r.held}
                      disabled={saving === r.id}
                      onChange={(e) => toggle(r.id, "held", e.target.checked)}
                      aria-label={`Mark ${r.organization || "booking"} as held`}
                      style={{ cursor: "pointer", accentColor: "var(--navy)" }}
                    />
                  </span>
                  <span style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={!!r.became_client}
                      disabled={saving === r.id}
                      onChange={(e) => toggle(r.id, "became_client", e.target.checked)}
                      aria-label={`Mark LOE sent for ${r.organization || "booking"}`}
                      style={{ cursor: "pointer", accentColor: "var(--olive)" }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
