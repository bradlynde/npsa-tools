"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Eyebrow, StatusPill } from "./ui";

/**
 * The curated NSGP deadline table, on the toolbox landing page.
 *
 * The question worth answering here is "is anything open right now?", which is
 * why the strip leads with that count rather than with how many rows the table
 * holds. A rep should be able to see there is money closing this month without
 * opening the generator, and without having a call booked at all.
 *
 * Read-only by design. The table is maintained in the Sales Toolbox app, which
 * owns the data; showing an editable copy here would create a second place a
 * deadline can be changed and a race between them. The footer links across.
 */

export type DeadlineRow = {
  id: number;
  state: string;
  program: string;
  cycle_year: number;
  deadline: string | null;
  kind: string | null;
  note: string | null;
  source: string | null;
  confidence: string | null;
  layer: string | null;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

/** "July 9, 2026" without going through Date — no timezone shift on a bare date. */
function pretty(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : "—";
}

const today = () => new Date().toISOString().slice(0, 10);

/** Days until a date, floored at zero. */
function daysAway(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function useDeadlines() {
  const [rows, setRows] = useState<DeadlineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
        const r = await fetch("/api/precall/deadlines", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`deadlines ${r.status}`);
        const d = await r.json();
        if (alive) setRows(d.deadlines || []);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const open = useMemo(
    () => (rows || [])
      .filter((r) => r.deadline && r.deadline >= today())
      .sort((a, b) => (a.deadline || "").localeCompare(b.deadline || "")),
    [rows],
  );

  return { rows, open, error, loading: rows === null && !error };
}

/** The strip that sits under the Pre-Call card. */
export function DeadlinesCard({
  onClick,
  open,
  total,
  loading,
  error,
}: {
  onClick: () => void;
  open: DeadlineRow[];
  total: number;
  loading: boolean;
  error: string | null;
}) {
  const label = error
    ? "table unavailable"
    : loading
      ? "loading…"
      : `${total} cycles on record`;

  return (
    <Card hover onClick={onClick} style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--fg)", marginBottom: 2 }}>
          NSGP Deadlines
        </div>
        <div style={{ fontSize: 13, color: "var(--sec)", lineHeight: 1.5 }}>
          {error ? "Could not reach the Sales Toolbox backend." : "Federal and state grant windows, by jurisdiction."}
        </div>
      </div>
      <Eyebrow style={{ whiteSpace: "nowrap" }}>{label}</Eyebrow>
      {/* A zero is a real answer and stays visible rather than collapsing. */}
      {!loading && !error && (
        <StatusPill tone={open.length ? "done" : "queued"}>
          {open.length ? `${open.length} open now` : "none open"}
        </StatusPill>
      )}
    </Card>
  );
}

/** The popout. */
export function DeadlinesModal({
  rows,
  open,
  onClose,
}: {
  rows: DeadlineRow[];
  open: DeadlineRow[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Everything else, newest cycle first — the open ones are pulled out above.
  const rest = rows
    .filter((r) => !open.includes(r))
    .sort((a, b) => (b.deadline || "").localeCompare(a.deadline || ""));

  const th: React.CSSProperties = {
    textAlign: "left", padding: "0 10px 7px", fontWeight: 500, fontSize: 11.5,
    letterSpacing: ".08em", color: "var(--mute)",
  };
  const td: React.CSSProperties = { padding: "7px 10px", fontSize: 13, verticalAlign: "top" };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 80, background: "rgba(12,16,24,.5)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "48px 16px", overflowY: "auto",
      }}
    >
      <Card
        onClick={() => {}}
        style={{ maxWidth: 900, width: "100%", padding: "24px 26px" }}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 19, fontWeight: 600, color: "var(--fg)" }}>NSGP Deadlines</div>
            <Eyebrow style={{ marginLeft: "auto" }}>esc to close</Eyebrow>
          </div>
          <div style={{ fontSize: 13, color: "var(--sec)", lineHeight: 1.6, marginBottom: 18 }}>
            Seeded from the grant-knowledge folder in Drive, then checked against each agency&rsquo;s
            own published material. A row marked <strong>verify</strong> is one nothing corroborated,
            or one the source itself flags as needing checking each cycle — the briefing prints it,
            but says so.
          </div>

          {open.length > 0 && (
            <>
              <Eyebrow style={{ marginBottom: 8 }}>open now</Eyebrow>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
                {open.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex", alignItems: "baseline", gap: 12, padding: "11px 14px",
                      border: "1px solid var(--bd2)", borderRadius: 11, background: "var(--bg)",
                    }}
                  >
                    <strong style={{ fontSize: 13.5, minWidth: 34 }}>{r.state}</strong>
                    <span className="mono" style={{ fontSize: 12, color: "var(--sec)", minWidth: 108 }}>
                      {r.program}
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{pretty(r.deadline)}</span>
                    <span style={{ fontSize: 12.5, color: "var(--sec)" }}>
                      {daysAway(r.deadline as string) === 0
                        ? "today"
                        : `in ${daysAway(r.deadline as string)} days`}
                    </span>
                    <span style={{ marginLeft: "auto" }}>
                      <StatusPill tone={r.confidence === "illustrative" ? "queued" : "done"}>
                        {r.confidence === "illustrative" ? "verify" : "confirmed"}
                      </StatusPill>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <Eyebrow style={{ marginBottom: 8 }}>every recorded cycle</Eyebrow>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead>
                <tr>
                  <th className="mono" style={{ ...th, width: 54 }}>state</th>
                  <th className="mono" style={{ ...th, width: 116 }}>program</th>
                  <th className="mono" style={{ ...th, width: 66 }}>fy</th>
                  <th className="mono" style={{ ...th, width: 148 }}>deadline</th>
                  <th className="mono" style={{ ...th, width: 96 }}>confidence</th>
                  <th className="mono" style={th}>source</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--bd)" }}>
                    <td style={{ ...td, fontWeight: 600 }}>{r.state}</td>
                    <td className="mono" style={{ ...td, fontSize: 12 }}>{r.program}</td>
                    <td className="mono" style={{ ...td, fontSize: 12 }}>FY{r.cycle_year}</td>
                    <td style={{ ...td, color: "var(--sec)" }}>{pretty(r.deadline)}</td>
                    <td style={td}>
                      <StatusPill tone={r.confidence === "illustrative" ? "queued" : "done"}>
                        {r.confidence === "illustrative" ? "verify" : "confirmed"}
                      </StatusPill>
                    </td>
                    <td style={{ ...td, fontSize: 11.5, color: "var(--mute)", wordBreak: "break-all" }}>
                      {r.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* One place a deadline can be changed, and it is not this one. */}
          <div style={{ fontSize: 12.5, color: "var(--sec)", marginTop: 16, lineHeight: 1.6 }}>
            Read-only here. Add a cycle, correct a date or promote a row to confirmed in the{" "}
            <a href="/loe?view=precall" style={{ color: "var(--olive)", fontWeight: 600 }}>
              Pre-Call Notes Generator
            </a>
            .
          </div>
        </div>
      </Card>
    </div>
  );
}
