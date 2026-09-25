"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { SCRAPER_LABELS } from "../lib/constants";
import StatusBadge from "./StatusBadge";
import type { CountyTask, ScraperType } from "../lib/types";

type SortKey = "county" | "status" | "found" | "contacts" | "withEmail" | "withoutEmail";
type SortDir = "asc" | "desc";

function getValue(task: CountyTask, key: SortKey): string | number {
  const r = task.result_json;
  switch (key) {
    case "county": return task.county;
    case "status": return task.status;
    case "found": return r?.churches ?? r?.schools ?? 0;
    case "contacts": return r?.contacts ?? 0;
    case "withEmail": return r?.contacts_with_emails ?? 0;
    case "withoutEmail": return r?.contacts_without_emails ?? 0;
    default: return 0;
  }
}

export default function CountyTable({ counties, scraperType }: {
  counties: CountyTask[];
  scraperType: ScraperType;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("county");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const labels = SCRAPER_LABELS[scraperType];

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = [...counties].sort((a, b) => {
    const va = getValue(a, sortKey);
    const vb = getValue(b, sortKey);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Sortable headers are buttons, so the sort works from a keyboard and reads as a control.
  const head = (key: SortKey, label: string, align: "left" | "right" = "left") => (
    <th aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"} style={{ textAlign: align }}>
      <button
        type="button"
        onClick={() => handleSort(key)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: 0, padding: 0, font: "inherit", color: sortKey === key ? "var(--ink)" : "inherit", cursor: "pointer" }}
      >
        {label}
        {sortKey === key && (sortDir === "asc" ? <ArrowUp size={13} strokeWidth={2} aria-hidden /> : <ArrowDown size={13} strokeWidth={2} aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div
      className="table-responsive card-surface"
      style={{ background: "var(--card)", borderRadius: "var(--r-lg)", overflow: "hidden", border: "1px solid var(--bd2)" }}
    >
      <table className="data-table">
        <thead>
          <tr>
            {head("county", "County")}
            {head("status", "Status")}
            {head("found", `${labels.plural} found`, "right")}
            {head("contacts", "Contacts", "right")}
            <th>Worker</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => {
            const r = task.result_json;
            return (
              <tr key={task.id || task.county} className="row-hover">
                <td style={{ fontWeight: 500 }}>{task.county}</td>
                <td><StatusBadge status={task.status} /></td>
                <td className="num" style={{ textAlign: "right" }}>{r?.churches ?? r?.schools ?? "—"}</td>
                <td className="num" style={{ textAlign: "right" }}>{r?.contacts ?? "—"}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--mute)" }}>{task.claimed_by ? task.claimed_by.substring(0, 12) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
