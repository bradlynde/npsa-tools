"use client";
import { useEffect, useMemo, useState } from "react";
import { Card, Eyebrow, Note, SegPill, Tag, PageHeading } from "../ui";
import { jurisdiction } from "../../lib/states";
import { gkGet, gkSend, fmtDay, fmtTime, countdown, type AttentionFull, type AttentionItem } from "./api";

/**
 * The verification queue: everything nobody has stood behind yet, grouped by state.
 *
 * Claude's research and the import both land here. Verifying is a person saying "I
 * checked this", so every row shows where the fact came from, links to its source,
 * and opens the record in place; "verify all" asks first.
 */
type Tab = "unverified" | "stale" | "deadlines" | "questions" | "gaps";
const ORIGIN: Record<string, string> = { research: "found by Claude", mcp: "via Claude", import: "imported", manual: "typed in" };
const btn: React.CSSProperties = { background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontSize: 12 };

export default function Queue({ onOpen, onBack }: { onOpen: (code: string, recordId?: number) => void; onBack: () => void }) {
  const [data, setData] = useState<AttentionFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("unverified");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    gkGet<AttentionFull>("needs-attention?days=60").then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [tick]);

  const groups = useMemo(() => {
    const rows = !data ? [] : tab === "stale" ? data.stale : data.unverified;
    const by = new Map<string, AttentionItem[]>();
    for (const r of rows) by.set(r.jurisdiction, [...(by.get(r.jurisdiction) || []), r]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data, tab]);

  async function verify(code: string, items: AttentionItem[]) {
    if (items.length > 1 && !window.confirm(`Mark ${items.length} records in ${jurisdiction(code)?.name} as verified by you? Do this only for what you have checked yourself.`)) return;
    setBusy(code); setErr(null);
    try {
      const r = await gkSend<{ failed: number }>("POST", `jurisdictions/${code}/verify-bulk`, { ids: items.map((x) => ({ id: x.record_id, version: x.version })) });
      if (r.failed) setErr(`${r.failed} record(s) in ${code} had changed in the meantime and were left alone.`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(null); setTick((t) => t + 1);
  }

  if (err && !data) return <Note>{err}</Note>;
  if (!data) return <div style={{ color: "var(--mute)", fontSize: 14, padding: "60px 0" }}>Loading the queue…</div>;
  const c = data.counts;

  return (
    <div>
      <button onClick={onBack} className="mono" style={{ ...btn, letterSpacing: ".06em", color: "var(--mute)", marginBottom: 18 }}>← all states</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
        <PageHeading eyebrow="grant knowledge · what needs a person">Nothing is true <em>until someone checks.</em></PageHeading>
        <SegPill<Tab> size="sm" value={tab} onChange={setTab} options={[
          { key: "unverified", label: `Unverified ${c.unverified}` }, { key: "stale", label: `Stale ${c.stale}` }, { key: "deadlines", label: `Deadlines ${c.deadlines_soon}` },
          { key: "questions", label: `Questions ${c.open_questions}` }, { key: "gaps", label: `Gaps ${c.missing}` },
        ]} />
      </div>
      {err && <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {(tab === "unverified" || tab === "stale") && (
        <>
          {!groups.length && <Card><div style={{ fontSize: 14, color: "var(--sec)" }}>{tab === "stale" ? "Nothing has gone stale: every verification is under a year old." : "Everything on record has been verified by someone."}</div></Card>}
          {groups.map(([code, items]) => (
            <Card key={code} style={{ marginBottom: 14, padding: "16px 22px" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" }}>
                <button onClick={() => onOpen(code)} className="serif" style={{ ...btn, fontSize: 20, color: "var(--ink)" }}>{jurisdiction(code)?.name}</button>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--mute)" }}>{items.length} to confirm</span>
                <button onClick={() => verify(code, items)} disabled={busy === code} className="mono" style={{ ...btn, color: "var(--ok-fg)", marginLeft: "auto" }}>{busy === code ? "verifying…" : `verify all ${items.length}…`}</button>
              </div>
              {items.map((r) => (
                <div key={r.record_id} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0", borderTop: "1px solid var(--hair2)", fontSize: 13.5, flexWrap: "wrap" }}>
                  <Tag>{r.kind}</Tag>
                  <button onClick={() => onOpen(code, r.record_id)} style={{ ...btn, fontSize: 13.5, color: "var(--ink)", textAlign: "left", flex: "1 1 260px" }}>{r.title}</button>
                  <span style={{ fontSize: 12, color: "var(--mute)" }}>
                    {tab === "stale" ? `verified ${fmtDay(r.verified_at || null)}` : r.fields?.length ? `changed since verified: ${r.fields.join(", ")}` : `${ORIGIN[r.origin] || r.origin}${r.updated_by && !r.updated_by.startsWith("import:") ? ` · ${r.updated_by}` : ""}`}
                  </span>
                  {r.source_url && <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 11.5, color: "var(--navy)" }}>source</a>}
                  <button onClick={() => verify(code, [r])} className="mono" style={{ ...btn, color: "var(--ok-fg)" }}>verify</button>
                </div>
              ))}
            </Card>
          ))}
        </>
      )}

      {tab === "deadlines" && (
        <Card>
          <Eyebrow style={{ marginBottom: 8 }}>deadlines in the next 60 days</Eyebrow>
          {!data.deadlines_soon.length && <div style={{ fontSize: 14, color: "var(--sec)" }}>None on record. Out of season, that is normal; in season, it means dates have not been entered.</div>}
          {data.deadlines_soon.map((d) => (
            <button key={d.record_id} onClick={() => onOpen(d.jurisdiction, d.record_id)} style={{ ...btn, display: "flex", gap: 12, width: "100%", padding: "9px 0", borderTop: "1px solid var(--hair2)", fontSize: 13.5, textAlign: "left", alignItems: "baseline" }}>
              <span className="mono" style={{ color: "var(--olive)", width: 26 }}>{d.jurisdiction}</span>
              <span style={{ flex: 1, color: "var(--ink)" }}>{d.program} · {d.label}{d.status !== "verified" ? " · unverified" : ""}</span>
              <span style={{ color: d.days_away <= 14 ? "var(--err-fg)" : "var(--sec)" }}>{fmtDay(d.due_date)}{d.due_time ? `, ${fmtTime(d.due_time, d.tz)}` : ""} · {countdown(d.days_away)}</span>
            </button>
          ))}
        </Card>
      )}

      {tab === "questions" && (
        <Card>
          <Eyebrow style={{ marginBottom: 8 }}>open questions</Eyebrow>
          {!data.open_questions.length && <div style={{ fontSize: 14, color: "var(--sec)" }}>No open questions.</div>}
          {data.open_questions.map((q) => (
            <button key={q.record_id} onClick={() => onOpen(q.jurisdiction, q.record_id)} style={{ ...btn, display: "flex", gap: 12, width: "100%", padding: "9px 0", borderTop: "1px solid var(--hair2)", fontSize: 13.5, textAlign: "left" }}>
              <span className="mono" style={{ color: "var(--warn-fg)", width: 26 }}>{q.jurisdiction}</span><span style={{ color: "var(--ink)" }}>{q.title}</span>
            </button>
          ))}
        </Card>
      )}

      {tab === "gaps" && (
        <Card>
          <Eyebrow style={{ marginBottom: 8 }}>holes worth filling</Eyebrow>
          {!data.missing.length && <div style={{ fontSize: 14, color: "var(--sec)" }}>No gaps found.</div>}
          {data.missing.map((m, i) => (
            <button key={i} onClick={() => onOpen(m.jurisdiction, m.record_id)} style={{ ...btn, display: "flex", gap: 12, width: "100%", padding: "9px 0", borderTop: "1px solid var(--hair2)", fontSize: 13.5, textAlign: "left" }}>
              <span className="mono" style={{ color: "var(--mute)", width: 26 }}>{m.jurisdiction}</span><span style={{ color: "var(--ink)" }}>{m.what}</span>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}
