import { useEffect, useState } from "react";

/*
 * Start a pre-call briefing by picking the meeting, not by pasting an email.
 *
 * The paste box is still there underneath, because a booking made outside Calendly
 * has to go somewhere. But when the meeting is on the calendar — which is almost
 * always — every field below fills itself from what the client actually submitted,
 * and nothing has to be re-typed or re-extracted.
 */

const CENTRAL = { timeZone: "America/Chicago" };

const dayLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const fmt = (x) => new Intl.DateTimeFormat("en-US", { ...CENTRAL, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const tomorrow = new Date(today.getTime() + 86400000);
  if (fmt(d) === fmt(today)) return "Today";
  if (fmt(d) === fmt(tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { ...CENTRAL, weekday: "short", month: "short", day: "numeric" }).format(d);
};

const timeLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { ...CENTRAL, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
};

const firstName = (email) => String(email || "").split("@")[0];

export default function BookingPicker({ selectedUri, onSelect }) {
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (refresh) => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/precall/bookings${refresh ? "?refresh=1" : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setBookings(d.bookings || []);
    } catch (e) {
      setError(e.message);
      setBookings([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(false); }, []);

  const card = {
    background: "#fff", borderRadius: 14, boxShadow: "0 2px 12px rgba(2,6,23,0.06)",
    border: "1px solid #f0ede5", padding: "16px 20px 18px",
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#182230" }}>&#128197; Start from a Booking</div>
        <button onClick={() => load(true)} disabled={loading}
          style={{ marginLeft: "auto", background: "none", border: "1px solid #e7e2d6", borderRadius: 7,
                   padding: "4px 10px", fontSize: 11.5, fontWeight: 600, color: "#4a5462",
                   cursor: loading ? "default" : "pointer" }}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#8a8577", marginBottom: 10 }}>
        Upcoming meetings across the team. Picking one fills the form from what the client
        submitted — phone, guests and conference details are used exactly as booked.
      </div>

      {error && (
        <div style={{ color: "#a3341f", background: "#fff5f5", border: "1px solid #f5c6c6",
                      borderRadius: 8, padding: "9px 12px", fontSize: 12.5 }}>
          Could not load bookings: {error}. Use the paste box below instead.
        </div>
      )}

      {bookings === null && !error && (
        <div style={{ fontSize: 12.5, color: "#8a8577", padding: "8px 0" }}>Loading upcoming bookings…</div>
      )}

      {bookings && bookings.length === 0 && !error && (
        <div style={{ fontSize: 12.5, color: "#8a8577", padding: "8px 0" }}>
          No upcoming bookings found. Use the paste box below.
        </div>
      )}

      {bookings && bookings.length > 0 && (
        <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {bookings.map((b) => {
            const on = b.eventUri === selectedUri;
            const f = b.facts || {};
            return (
              <button key={b.eventUri} onClick={() => onSelect(on ? null : b)}
                style={{ textAlign: "left", background: on ? "#f2f6fc" : "#fff",
                         border: `1px solid ${on ? "#1e3a5f" : "#ece8de"}`, borderRadius: 10,
                         padding: "9px 12px", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <div style={{ minWidth: 96 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#182230" }}>{dayLabel(b.startTime)}</div>
                  <div style={{ fontSize: 11, color: "#8a8577" }}>{timeLabel(b.startTime)}</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#182230" }}>
                    {f.orgName || <span style={{ color: "#a09a8c", fontWeight: 600 }}>Organization not given</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#4a5462" }}>
                    {f.inviteeName || f.inviteeEmail}
                    {b.host?.name ? ` · with ${b.host.name}` : ""}
                  </div>
                  {(f.guests || []).length > 0 && (
                    // Surfaced on the list, not just inside the notes — a rep should be
                    // able to see a second attendee before generating anything.
                    <div style={{ fontSize: 11, color: "#3a2c6e", marginTop: 2 }}>
                      +{f.guests.length} guest{f.guests.length > 1 ? "s" : ""}: {f.guests.map(firstName).join(", ")}
                    </div>
                  )}
                </div>
                {on && <div style={{ fontSize: 11, fontWeight: 700, color: "#1e3a5f" }}>&#10003;</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Maps a picked booking onto the pre-call form's field names. */
export function bookingToForm(b, prev) {
  const f = b.facts || {};
  const d = f.startTime ? new Date(f.startTime) : null;
  const parts = d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat("en-CA", { ...CENTRAL, year: "numeric", month: "2-digit", day: "2-digit",
                                         hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d)
        .reduce((a, p) => (a[p.type] = p.value, a), {})
    : null;
  return {
    ...prev,
    orgName: f.orgName || "",
    orgState: f.orgState || prev.orgState || "",
    websiteUrl: f.websiteUrl || "",
    // The date/time inputs are for the rep's reference; generation uses the
    // booking's own ISO timestamp, so a mis-keyed minute here cannot change the notes.
    meetingDate: parts ? `${parts.year}-${parts.month}-${parts.day}` : "",
    meetingTime: parts ? `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` : "",
    meetingTimezone: "CST",
    zoomUrl: f.location?.joinUrl || "",
    zoomId: f.location?.meetingId || "",
    zoomPassword: f.location?.passcode || "",
    attendees: [
      { name: f.inviteeName || "", email: f.inviteeEmail || "", phone: f.inviteePhone || "" },
      ...(f.guests || []).map((email) => ({ name: "", email, phone: "" })),
    ],
  };
}
