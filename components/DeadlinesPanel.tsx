"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Eyebrow, StatusPill } from "./ui";

/**
 * The curated NSGP deadline table, on the toolbox landing page.
 *
 * The question worth answering here is "is anything open right now?", which is
 * why the card on the page leads with that count. A rep should be able to see
 * there is money closing this month without opening the generator, and without
 * having a call booked at all. That card is an ActionCard in the toolbox page, so
 * it stays on the same styling as every other tool; this file owns the data and
 * the panel.
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
        overflowY: "auto",
      }}
    >
      {/*
        Same 1280 / 40px geometry as <Page>, so the panel lands on the page's own
        column rather than floating at some width of its own. The cards behind it
        line up with its edges.
      */}
      <div
        style={{
          width: "100%", maxWidth: 1280, margin: "0 auto",
          padding: "48px 40px", boxSizing: "border-box",
        }}
      >
      <Card
        onClick={() => {}}
        style={{ width: "100%", padding: "24px 26px" }}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 19, fontWeight: 600, color: "var(--fg)" }}>NSGP Deadlines</div>
            <Eyebrow style={{ marginLeft: "auto" }}>esc to close</Eyebrow>
            {/* Escape is not discoverable, so there is a button too. */}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                width: 30, height: 30, flexShrink: 0, display: "flex",
                alignItems: "center", justifyContent: "center",
                background: "transparent", border: "1px solid var(--bd2)",
                borderRadius: 9, color: "var(--sec)", cursor: "pointer",
                lineHeight: 1, padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg)";
                e.currentTarget.style.color = "var(--fg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--sec)";
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
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
    </div>
  );
}
