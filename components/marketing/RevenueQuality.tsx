"use client";

import { useState } from "react";
import { Card, Eyebrow, Note, fmtMoney, fmtInt } from "../ui";
import type { RevenueQuality as RQ } from "../../lib/marketing";

/**
 * Whether the two ways of counting revenue still agree.
 *
 * Revenue comes from financial records; the opportunity total sits beside it only
 * so a divergence has somewhere to show. The $200k gap existed for months because
 * nothing ever put the two numbers in the same place — it was found in a meeting,
 * not by the dashboard. This panel is the thing that would have found it.
 *
 * It stays visible when everything reconciles. A check that only appears when it
 * fails teaches nobody to look for it.
 */
export default function RevenueQuality({ data }: { data: RQ | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;

  const { flags, excluded } = data;
  const groups = [
    {
      key: "lost",
      rows: flags.closed_lost_opportunity,
      title: "on a closed-lost opportunity",
      // The Central Wesleyan failure by name, so the panel explains itself.
      why: "Counted — the contract is real. But the opportunity says the deal was lost, so one of the two is wrong in Salesforce.",
      render: (r: RQ["flags"]["closed_lost_opportunity"][number]) =>
        `${r.organization || r.name || r.financial_id} · ${fmtMoney(r.amount)} · ${r.opportunity_stage || "no stage"}`,
    },
    {
      key: "orphan",
      rows: flags.orphaned_or_mismatched,
      title: "with no opportunity, or the wrong one",
      why: "Not counted. The Salesforce report is built on financials that have an opportunity, so these sit outside the total until the link is fixed.",
      render: (r: RQ["flags"]["orphaned_or_mismatched"][number]) =>
        `${r.organization || r.financial_id} · ${fmtMoney(r.amount)} · ${r.problem}`,
    },
    {
      key: "split",
      rows: flags.split_across_opportunities,
      title: "split across several opportunities",
      why: "The shape that caused the original mis-link. Not wrong by itself, but it is where a contract ends up on the wrong record.",
      render: (r: RQ["flags"]["split_across_opportunities"][number]) =>
        `${r.organization} · ${r.financials} financials over ${r.opportunities} opportunities · ${r.stages.join(", ")}`,
    },
  ].filter((g) => g.rows.length > 0);

  const excludedRows = Object.entries(excluded).filter(([, v]) => v.count > 0);
  const LABELS: Record<string, string> = {
    other_purpose: `not a ${data.filters.purpose.toLowerCase()}`,
    non_security: "flagged as non-security work",
    before_start: `created before ${data.filters.since}`,
  };

  const delta = data.delta;
  const agree = Math.abs(delta) < 1;

  return (
    <Card style={{ marginBottom: 14 }}>
      <Eyebrow style={{ marginBottom: 12 }}>revenue · how it is counted</Eyebrow>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          gap: 16,
          marginBottom: groups.length || excludedRows.length ? 16 : 0,
        }}
      >
        <Figure
          label="from financial records"
          value={fmtMoney(data.financial_total)}
          note={`${fmtInt(data.financial_count)} records · what the dashboard shows`}
          strong
        />
        <Figure
          label="from won opportunities"
          value={fmtMoney(data.opportunity_total)}
          note={`${fmtInt(data.opportunity_count)} opportunities · the old basis`}
        />
        <Figure
          label="difference"
          value={`${delta >= 0 ? "+" : "−"}${fmtMoney(Math.abs(delta))}`}
          note={
            agree
              ? "the two agree"
              : delta > 0
              ? "opportunities under-report by this much"
              : "opportunities over-report by this much"
          }
          tone={agree ? "ok" : "warn"}
        />
      </div>

      <div style={{ fontSize: 12.5, color: "var(--mute)", marginBottom: excludedRows.length || groups.length ? 14 : 0 }}>
        Revenue is summed from financial records, never from opportunity stage — a signed
        contract on a closed-lost opportunity is still revenue.
      </div>

      {excludedRows.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--mute)", marginBottom: groups.length ? 14 : 0 }}>
          <strong style={{ color: "var(--sec)" }}>Left out:</strong>{" "}
          {excludedRows
            .map(([k, v]) => `${v.count} ${LABELS[k] || k} (${fmtMoney(v.amount)})`)
            .join(" · ")}
        </div>
      )}

      {groups.length === 0 ? (
        <Note>Every financial record lines up with its opportunity.</Note>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((g) => {
            const isOpen = open === g.key;
            return (
              <div
                key={g.key}
                style={{
                  border: "1px solid var(--warn-fg)",
                  background: "var(--warn-bg)",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : g.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontSize: 13,
                    color: "var(--warn-fg)",
                    fontWeight: 600,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span>
                    {g.rows.length} {g.rows.length === 1 ? "record" : "records"} {g.title}
                  </span>
                  <span style={{ marginLeft: "auto", fontWeight: 500 }}>{isOpen ? "▾" : "▸"}</span>
                </button>
                <div style={{ fontSize: 12.5, color: "var(--sec)", marginTop: 5 }}>{g.why}</div>
                {isOpen && (
                  <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--sec)" }}>
                    {g.rows.map((r, i) => (
                      <li key={i} style={{ marginBottom: 3 }}>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {g.render(r as any)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Figure({
  label,
  value,
  note,
  strong,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  strong?: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div>
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
        {label}
      </div>
      <div
        style={{
          fontSize: strong ? 26 : 22,
          fontWeight: strong ? 600 : 500,
          fontVariantNumeric: "tabular-nums",
          color: tone === "warn" ? "var(--warn-fg)" : strong ? "var(--ink)" : "var(--sec)",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--faint)", marginTop: 4 }}>{note}</div>
    </div>
  );
}
