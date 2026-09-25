"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ChevronRight } from "lucide-react";
import { Card, Eyebrow, SegPill, ChipRow, Tag, Note, Button, Skeleton, useConfirm } from "../ui";
import RecordEditor, { EditContext, RecActions, AddButton, useEdit, type EditTarget } from "./RecordEditor";
import { useMedia } from "../../lib/useMedia";
import Markdown from "./Markdown";
import Files from "./Files";
import {
  gkGet, gkSend, GkError, usd, fmtDay, fmtTime, countdown, CYCLE_LABEL,
  type StateDoc, type Program, type Rec, type Requirement, type Revision, type Cycle,
} from "./api";

/* ── Small pieces ───────────────────────────────────────────────── */

/** Whether a person has stood behind this record, said quietly when they have and plainly when they have not. */
export function Trust({ rec, quiet = false }: { rec: Pick<Rec, "effective_status" | "unverified_fields" | "verified_by" | "verified_at" | "origin" | "updated_by"> ; quiet?: boolean }) {
  const flagged = rec.unverified_fields.length;
  if (rec.effective_status === "verified" && !flagged) {
    if (quiet) return null;
    return <span title={`Verified by ${rec.verified_by}, ${fmtDay(rec.verified_at)}`} className="badge badge-dot badge-ok">Verified</span>;
  }
  const stale = rec.effective_status === "stale";
  const text = stale ? "Stale" : flagged && rec.effective_status === "verified" ? `${flagged} field${flagged === 1 ? "" : "s"} to confirm` : "Unverified";
  const why = stale ? `Verified by ${rec.verified_by} on ${fmtDay(rec.verified_at)}: over a year ago` : flagged && rec.effective_status === "verified" ? `Changed since it was verified: ${rec.unverified_fields.join(", ")}` : `Nobody has confirmed this yet (${rec.origin === "research" ? "found by Claude" : rec.origin === "import" ? "imported" : `added by ${rec.updated_by}`})`;
  return (
    <span title={why} className="badge badge-dot badge-warn">
      {text}
    </span>
  );
}

/**
 * A section that folds. A native <details>, so find-in-page and a #rec-123 link
 * open it on their own in Chrome, and the state of each fold is the browser's, not
 * React's: `open` is rendered from a value fixed at mount, so React never writes it
 * again and a person's toggle sticks through the reloads that follow every save.
 */
function Fold({ id, title, meta, open = false, right, tight = false, children }: { id?: string; title: React.ReactNode; meta?: React.ReactNode; open?: boolean; right?: React.ReactNode; tight?: boolean; children: React.ReactNode }) {
  const [initial] = useState(open);
  return (
    <details open={initial} id={id} className="gk-fold" style={{ scrollMarginTop: 90, marginTop: tight ? 20 : 0, paddingTop: tight ? 14 : 0, borderTop: tight ? "1px solid var(--hair2)" : undefined }}>
      <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: "pointer", listStyle: "none", padding: "4px 0", userSelect: "none" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <ChevronRight aria-hidden className="gk-chev" size={15} strokeWidth={2} style={{ color: "var(--mute)", transition: "transform .15s", flexShrink: 0, alignSelf: "center" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{title}</span>
          {meta && <span className="meta">{meta}</span>}
        </span>
        {right && <span onClick={(e) => e.preventDefault()} style={{ display: "flex", gap: 10, alignItems: "center" }}>{right}</span>}
      </summary>
      <div style={{ paddingTop: 10 }}>{children}</div>
      <style>{`.gk-fold[open] > summary .gk-chev { transform: rotate(90deg); } .gk-fold > summary::-webkit-details-marker { display: none; } .gk-rows > li:last-child, .gk-rows > div:last-child { border-bottom: none; }`}</style>
    </details>
  );
}

function Section({ id, title, meta, open = false, children }: { id?: string; title: string; meta?: React.ReactNode; open?: boolean; children: React.ReactNode }) {
  return (
    <section style={{ paddingTop: 16, marginTop: 16, borderTop: "1px solid var(--hair2)" }}>
      <Fold id={id} title={title} meta={meta} open={open}>{children}</Fold>
    </section>
  );
}

const Faint = ({ children }: { children: React.ReactNode }) => <span style={{ color: "var(--mute)" }}>{children}</span>;

function Fact({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "148px minmax(0, 1fr)", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--hair2)", alignItems: "baseline", breakInside: "avoid" }}>
      <div style={{ fontSize: 13, color: "var(--mute)" }}>{label}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 500 }}>{value}</div>
        {note && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 3, lineHeight: 1.45 }}>{note}</div>}
      </div>
    </div>
  );
}

/** The header cards: label above value, a short note beneath. */
function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, color: "var(--ink)", fontWeight: 500, lineHeight: 1.35 }}>{value}</div>
      {note && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 5, lineHeight: 1.45 }}>{note}</div>}
    </div>
  );
}

/** A group of rows inside a fold: a small heading, then a bordered panel the rows sit in. */
function Panel({ title, count, children }: { title?: string; count?: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {title && <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sec)", margin: "0 0 6px 2px" }}>{title}{typeof count === "number" && <Faint> · {count}</Faint>}</div>}
      <div className="gk-rows" style={{ border: "1px solid var(--bd2)", borderRadius: 10, padding: "2px 14px" }}>{children}</div>
    </div>
  );
}

const SEVERITY: Record<string, { label: string; fg: string; tone: string }> = {
  auto_disqualifier: { label: "Ends the application", fg: "var(--err-fg)", tone: "badge-err" },
  critical: { label: "Critical", fg: "var(--err-fg)", tone: "badge-err" },
  caution: { label: "Caution", fg: "var(--warn-fg)", tone: "badge-warn" },
};
const CATEGORY: Record<string, string> = {
  gotcha: "Gotchas", eligibility: "Eligibility", prohibited_cost: "Prohibited costs", scoring: "Scoring", process: "Process",
  history: "History and patterns", post_award: "Post-award", watch_item: "Watch items", open_question: "Open questions",
};
const CATEGORY_ORDER = Object.keys(CATEGORY);
const SEVERITY_RANK = ["auto_disqualifier", "critical", "caution", "info", undefined];

function NoteCard({ n, program }: { n: Rec; program?: string }) {
  const sev = SEVERITY[n.data.severity as string];
  const long = (n.data.body_md || "").length > 420;
  const [open, setOpen] = useState(!long);
  return (
    <div id={`rec-${n.id}`} style={{ padding: "12px 14px", border: "1px solid var(--bd2)", borderLeft: `3px solid ${sev ? sev.fg : "var(--bd2)"}`, borderRadius: 10, background: "var(--card)", scrollMarginTop: 90 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: n.data.body_md ? 6 : 0 }}>
        <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 14, lineHeight: 1.35 }}>{n.data.title}</span>
        {sev && <span className={`badge badge-dot ${sev.tone}`}>{sev.label}</span>}
        {program && <Tag>{program}</Tag>}
        {n.data.client_slug && <a href="/grant-writing" title="From the field: learned on this engagement" style={{ fontSize: 13, color: "var(--navy)" }}>From <span className="mono" style={{ fontSize: 12 }}>{n.data.client_slug}</span></a>}
        <Trust rec={n} quiet />
        <RecActions rec={n} />
      </div>
      {n.data.body_md && (open
        ? <Markdown>{n.data.body_md}</Markdown>
        : <div style={{ fontSize: 14, color: "var(--sec)", lineHeight: 1.55 }}>{String(n.data.body_md).replace(/\n\s*[-*•]\s+/g, " · ").replace(/^\s*[-*•]\s+/, "").replace(/[*_`>#|]/g, "").replace(/\s+/g, " ").slice(0, 300)}… <button onClick={() => setOpen(true)} style={linkBtn}>read on</button></div>)}
      {n.source_url && <a href={n.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 500, color: "var(--navy)" }}>Source</a>}
    </div>
  );
}
const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, color: "var(--navy)", cursor: "pointer", fontSize: 13, fontWeight: 500 };

function RequirementRow({ r }: { r: Requirement }) {
  const d = r.data;
  return (
    <li id={`rec-${r.id}`} style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--hair2)", alignItems: "flex-start", scrollMarginTop: 90 }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 6, borderRadius: 2, flexShrink: 0, background: d.hard_gate ? "var(--err-fg)" : d.owner === "npsa" ? "var(--navy)" : "var(--olive)" }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "baseline" }}>
          <span style={{ color: "var(--ink)", fontSize: 14, fontWeight: 500 }}>{d.label}</span>
          {d.hard_gate && <span className="badge badge-dot badge-err" title="Nothing else can happen until this is done">Hard gate</span>}
          <span style={{ fontSize: 13, color: "var(--mute)" }}>
            {d.owner === "npsa" ? "NPSA" : "Client"}{d.lead_time_days ? ` · allow ${d.lead_time_days} days` : ""}{d.format ? ` · ${d.format}` : ""}{r.baseline === "federal" ? " · federal baseline" : ""}{r.inherited_from ? ` · same as ${r.inherited_from}` : ""}
          </span>
          <Trust rec={r} quiet />
          {!r.inherited_from && <RecActions rec={r} />}
        </div>
        {d.notes && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 4, lineHeight: 1.55 }}>{d.notes}</div>}
      </div>
    </li>
  );
}

type Owner = "all" | "client" | "npsa";
function Requirements({ p }: { p: Program }) {
  const [owner, setOwner] = useState<Owner>("all");
  const all = [...p.inherited_requirements, ...p.requirements];
  const { on: editing } = useEdit();
  if (!all.length && !editing) return null;
  const order = (a: Requirement, b: Requirement) => Number(!!b.data.hard_gate) - Number(!!a.data.hard_gate) || (b.data.lead_time_days || 0) - (a.data.lead_time_days || 0);
  const show = (t: string) => all.filter((r) => r.data.req_type === t && (owner === "all" || (r.data.owner || "client") === owner)).sort(order);
  const reg = show("registration"), docs = show("document");
  return (
    <Fold tight title="What a submission needs" meta={`${reg.length + docs.length}`}
      right={<><AddButton spec={{ jurisdiction: p.jurisdiction, kind: "requirement", parent_id: p.id, heading: `New requirement for ${p.key}` }}>requirement</AddButton><ChipRow<Owner> options={[{ key: "all", label: "Everyone" }, { key: "client", label: "Client" }, { key: "npsa", label: "NPSA" }]} value={owner} onChange={setOwner} /></>}>
      {[["Registration, before anything else", reg], ["Documents in the package", docs]].map(([title, rows]) => (
        <Panel key={title as string} title={title as string} count={(rows as Requirement[]).length}>
          {(rows as Requirement[]).length
            ? <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="gk-rows">{(rows as Requirement[]).map((r) => <RequirementRow key={`${r.id}-${r.inherited_from || ""}`} r={r} />)}</ul>
            : <div style={{ fontSize: 13, padding: "9px 0" }}><Faint>Nothing recorded.</Faint></div>}
        </Panel>
      ))}
    </Fold>
  );
}

/** Allocation by fiscal year, as bars. Drawn only when there are at least two years to compare. */
function FundingChart({ cycles }: { cycles: Cycle[] }) {
  const pts = cycles.map((c) => ({ fy: c.data.fiscal_year as number, v: (c.data.state_allocation ?? c.data.total_funding) as number | undefined, verified: c.effective_status === "verified" })).filter((p) => typeof p.v === "number").sort((a, b) => a.fy - b.fy);
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((p) => p.v!));
  const W = 46, H = 84;
  return (
    <svg viewBox={`0 0 ${pts.length * W} ${H + 34}`} style={{ width: Math.min(pts.length * 64, 420), height: "auto", marginTop: 12 }} role="img" aria-label="Funding by fiscal year">
      {pts.map((p, i) => {
        const h = Math.max(3, (p.v! / max) * H);
        return (
          <g key={p.fy}>
            <rect x={i * W + 8} y={H - h + 12} width={W - 16} height={h} rx={3} fill={p.verified ? "var(--olive)" : "var(--track)"} />
            <text x={i * W + W / 2} y={H - h + 8} textAnchor="middle" fontSize="9" fill="var(--sec)" className="num">{p.v! >= 1e6 ? `$${(p.v! / 1e6).toFixed(p.v! >= 1e7 ? 0 : 1)}M` : `$${Math.round(p.v! / 1e3)}k`}</text>
            <text x={i * W + W / 2} y={H + 26} textAnchor="middle" fontSize="9" fill="var(--mute)" className="num">FY{String(p.fy).slice(2)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Cycles({ p }: { p: Program }) {
  const addCycle = <AddButton spec={{ jurisdiction: p.jurisdiction, kind: "cycle", parent_id: p.id, heading: `New cycle for ${p.key}` }}>cycle</AddButton>;
  if (!p.cycles.length) return <div style={{ fontSize: 13, marginTop: 14 }}><Faint>No cycle recorded yet: no deadline history, no funding history.</Faint> {addCycle}</div>;
  const today = new Date().toISOString().slice(0, 10);
  const money = (c: Cycle) => typeof c.data.state_allocation === "number" ? ["State allocation", usd(c.data.state_allocation)] : typeof c.data.total_funding === "number" ? ["Total", usd(c.data.total_funding)] : null;
  return (
    <Fold tight title="Cycles, deadlines and funding" meta={`${p.cycles.length} cycle${p.cycles.length === 1 ? "" : "s"}`} right={addCycle}>
      {p.cycles.map((c) => {
        const m = money(c);
        const meta = [c.data.open_date ? `Opened ${fmtDay(c.data.open_date)}` : "", c.data.nofo_date ? `NOFO ${fmtDay(c.data.nofo_date)}` : "",
          typeof c.data.awards === "number" ? `${c.data.awards} awards${typeof c.data.applications === "number" ? ` of ${c.data.applications} applications` : ""}` : ""].filter(Boolean);
        return (
          <div key={c.id} id={`rec-${c.id}`} style={{ border: "1px solid var(--bd2)", borderRadius: 10, padding: "12px 16px", marginBottom: 10, scrollMarginTop: 90 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 15 }}>{c.title}</span>
                {c.data.status && <span className="meta">{String(c.data.status).replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</span>}
                <Trust rec={c} quiet /><RecActions rec={c} />
              </div>
              {m && <div style={{ fontSize: 14, color: "var(--sec)" }}>{m[0]} <b style={{ color: "var(--ink)", fontWeight: 600 }}>{m[1]}</b></div>}
            </div>
            <div style={{ marginTop: 8 }}>
              {c.deadlines.map((d) => (
                <div key={d.id} id={`rec-${d.id}`} style={{ padding: "7px 0", borderTop: "1px solid var(--hair2)", opacity: d.data.due_date < today ? 0.82 : 1, fontSize: 14 }}>
                  <span style={{ color: "var(--ink)", fontWeight: 600 }}>{fmtDay(d.data.due_date)}</span>
                  {d.data.due_time && <span style={{ color: "var(--sec)" }}> · {fmtTime(d.data.due_time, d.data.tz)}</span>}
                  <span style={{ color: "var(--sec)" }}> · {d.data.label}</span>{" "}
                  {d.data.confidence && d.data.confidence !== "confirmed" && <span className="badge badge-warn" style={{ marginRight: 6 }}>{String(d.data.confidence).replace(/^./, (x) => x.toUpperCase())}</span>}
                  <Trust rec={d} quiet /><RecActions rec={d} />
                  {d.data.note && <div style={{ fontSize: 13, color: "var(--sec)", lineHeight: 1.5, marginTop: 3, maxWidth: 760 }}>{d.data.note}</div>}
                </div>
              ))}
              {!c.deadlines.length && <div style={{ padding: "7px 0", borderTop: "1px solid var(--hair2)", fontSize: 13 }}><Faint>No deadline recorded.</Faint></div>}
              {(meta.length > 0 || c.data.notes || c.data.ua_allocations) && (
                <div style={{ paddingTop: 8, borderTop: "1px solid var(--hair2)", fontSize: 13, color: "var(--sec)", lineHeight: 1.5 }}>
                  {meta.length > 0 && <div className="meta" style={{ marginBottom: c.data.notes ? 3 : 0 }}>{meta.join(" · ")}</div>}
                  {c.data.ua_allocations && <div>{Object.entries(c.data.ua_allocations as Record<string, number>).map(([k, v]) => <span key={k} style={{ marginRight: 14 }}>{k.replace(/_/g, " ")} <b style={{ color: "var(--ink)" }}>{usd(v)}</b></span>)}</div>}
                  {c.data.notes && <div style={{ maxWidth: 760 }}>{c.data.notes}</div>}
                </div>
              )}
              <div style={{ marginTop: 4 }}><AddButton spec={{ jurisdiction: p.jurisdiction, kind: "deadline", parent_id: c.id, heading: `New deadline in ${c.title}` }}>deadline</AddButton></div>
            </div>
          </div>
        );
      })}
      <FundingChart cycles={p.cycles} />
    </Fold>
  );
}

function ContactLine({ c }: { c: Rec }) {
  const d = c.data;
  return (
    <div id={`rec-${c.id}`} style={{ padding: "10px 0", borderBottom: "1px solid var(--hair2)", scrollMarginTop: 90 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 14 }}>{d.name || d.org || d.role || d.email}</span>
        {(d.name ? [d.role, d.org] : [d.name ? d.org : d.role]).filter(Boolean).map((x: string) => <span key={x} style={{ fontSize: 13, color: "var(--sec)" }}>{x}</span>)}
        {d.area && <Tag>{d.area}</Tag>}
        {d.is_primary && <Tag>primary</Tag>}
        <Trust rec={c} quiet /><RecActions rec={c} />
      </div>
      <div style={{ fontSize: 13, marginTop: 3, display: "flex", gap: 14, flexWrap: "wrap" }}>
        {d.email && <a href={`mailto:${d.email}`} style={{ color: "var(--navy)" }}>{d.email}</a>}
        {d.phone && <a href={`tel:${String(d.phone).replace(/[^\d+]/g, "")}`} style={{ color: "var(--navy)" }}>{d.phone}</a>}
      </div>
      {d.warning && <div style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 13, color: "var(--warn-fg)", marginTop: 4, lineHeight: 1.45 }}><AlertTriangle size={14} strokeWidth={2} aria-hidden style={{ marginTop: 2, flexShrink: 0 }} />{d.warning}</div>}
      {d.notes && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 3, lineHeight: 1.45 }}>{d.notes}</div>}
    </div>
  );
}

/**
 * One program, folded: the header is a one-line digest (caps, sites, the latest
 * deadline) so a state with four programs is four lines until one is opened. Inside,
 * the facts and how it is submitted come first; what a submission needs, the cycles
 * and the notes fold again, closed like everything else until asked for.
 */
function ProgramCard({ p }: { p: Program }) {
  const narrow = useMedia("(max-width: 760px)");
  const [initial] = useState(false);
  const d = p.data;
  const fn = d.field_notes || {};
  const off = d.status && d.status !== "active";
  const latest = p.cycles.flatMap((c) => c.deadlines).sort((a, b) => b.data.due_date.localeCompare(a.data.due_date))[0];
  const today = new Date().toISOString().slice(0, 10);
  const digest = [
    typeof d.cap_per_location === "number" ? `${usd(d.cap_per_location)} per site` : "",
    typeof d.cap_per_applicant === "number" ? `${usd(d.cap_per_applicant)} per applicant` : "",
    typeof d.locations_max === "number" ? `up to ${d.locations_max} sites` : "",
    latest ? `${latest.data.due_date >= today ? "next" : "last"} deadline ${fmtDay(latest.data.due_date)}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <Card style={{ marginBottom: 12, scrollMarginTop: 90, padding: "6px 24px" }} className="" >
      <details open={initial} id={`program-${p.key}`} className="gk-fold" style={{ scrollMarginTop: 90 }}>
      <summary style={{ cursor: "pointer", listStyle: "none", padding: "14px 0", userSelect: "none" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <ChevronRight aria-hidden className="gk-chev" size={15} strokeWidth={2} style={{ color: "var(--mute)", transition: "transform .15s", flexShrink: 0, alignSelf: "center" }} />
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: d.type === "state" ? "var(--olive-ink)" : "var(--navy)" }}>{p.key}</span>
          <h3 className="serif" style={{ margin: 0, fontSize: 21, fontWeight: 500, color: "var(--ink)" }}>{d.name}</h3>
          <Tag>{d.type === "state" ? "state-funded" : "federal"}</Tag>
          {off && <span className="badge badge-dot badge-warn">{String(d.status).replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</span>}
          <Trust rec={p} />
        </div>
        {(digest || d.administered_by) && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 5, marginLeft: 25 }}>{digest}{digest && d.administered_by ? " · " : ""}{d.administered_by ? `run by ${d.administered_by}` : ""}</div>}
        <style>{`.gk-fold[open] > summary .gk-chev { transform: rotate(90deg); } .gk-fold > summary::-webkit-details-marker { display: none; }`}</style>
      </summary>
      <div style={{ paddingBottom: 16 }}>
      <div style={{ display: "flex", gap: 14, marginBottom: 4 }}><RecActions rec={p} /></div>
      {d.availability_note && <Note>{d.availability_note}</Note>}

      {/* Two balanced columns rather than a grid: a grid aligns rows, so one long note (Texas's period of performance) would open a hole beside every short fact. */}
      <div style={{ columnCount: narrow ? 1 : 2, columnGap: 40, margin: "12px 0 4px" }}>
        {typeof d.cap_per_location === "number" && <Fact label="Cap per site" value={usd(d.cap_per_location)} note={fn.cap_per_location} />}
        {typeof d.cap_per_applicant === "number" && <Fact label="Cap per applicant" value={usd(d.cap_per_applicant)} note={fn.cap_per_applicant} />}
        {typeof d.locations_max === "number" && <Fact label="Sites" value={`Up to ${d.locations_max}`} note={fn.locations_max} />}
        {typeof d.ma_pct === "number" && <Fact label="M&A" value={d.ma_pct ? `${d.ma_pct}%` : "Not allowed"} note={fn.ma_pct} />}
        {d.cost_match && <Fact label="Cost match" value={d.cost_match} note={fn.cost_match} />}
        {typeof d.pop_months === "number" && <Fact label="Period of performance" value={`${d.pop_months} months`} note={fn.pop_months || d.pop_note} />}
        {d.stackable !== undefined && <Fact label="Stacks with federal" value={d.stackable === true ? "Yes" : d.stackable === false ? "No" : "Unconfirmed"} note={fn.stackable} />}
        {d.exclusive_with?.length > 0 && <Fact label="Cannot also win" value={d.exclusive_with.join(", ")} note="May apply to both; only one can be awarded." />}
        {d.deadline_authority && <Fact label="Whose deadline binds" value={d.deadline_authority} />}
      </div>

      {d.submission && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--sand)", borderRadius: 10 }}>
          <div style={{ fontSize: 14, color: "var(--ink)" }}>
            <b style={{ fontWeight: 600 }}>How it is submitted:</b> {d.submission.method || "not recorded"}
            {d.submission.url ? <> via <a href={d.submission.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)", wordBreak: "break-word" }}>{d.submission.target || d.submission.url}</a></> : d.submission.target ? <> via {d.submission.target}</> : null}
          </div>
          {d.submission.package_note && <Markdown style={{ marginTop: 6, fontSize: 14 }}>{d.submission.package_note}</Markdown>}
          {d.file_naming && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 6 }}><b style={{ fontWeight: 600 }}>File naming:</b> {d.file_naming}</div>}
        </div>
      )}

      <Requirements p={p} />
      <Cycles p={p} />

      {(d.notes_md || d.eligible_costs) && (
        <Fold tight title="Program notes">
          {d.notes_md && <Markdown>{d.notes_md}</Markdown>}
          {d.eligible_costs && <><Eyebrow style={{ margin: "10px 0 6px" }}>Eligible costs</Eyebrow><Markdown>{d.eligible_costs}</Markdown></>}
        </Fold>
      )}
      {p.contacts.length > 0 && <Fold tight title="Program contacts" meta={`${p.contacts.length}`}><Panel>{p.contacts.map((c) => <ContactLine key={c.id} c={c} />)}</Panel></Fold>}
      <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
        <AddButton spec={{ jurisdiction: p.jurisdiction, kind: "note", parent_id: p.id, heading: `New note on ${p.key}` }}>note on this program</AddButton>
        <AddButton spec={{ jurisdiction: p.jurisdiction, kind: "contact", parent_id: p.id, preset: { contact_kind: "program" }, heading: `New contact for ${p.key}` }}>program contact</AddButton>
      </div>
      </div>
      </details>
    </Card>
  );
}

/* ── Playbook: the same facts, in the order an engagement meets them ── */

const PHASES: { key: string; title: string; blurb: string }[] = [
  { key: "before_nofo", title: "Before the NOFO", blurb: "What has to be true before the window opens. Most lost cycles are lost here." },
  { key: "registration", title: "Registration", blurb: "Accounts and portals. Start the hard gates on day one." },
  { key: "application", title: "Building the application", blurb: "The documents in the package and how this state wants them." },
  { key: "submission", title: "Submission", blurb: "How and when it goes in." },
  { key: "post_award", title: "After the award", blurb: "What changes once the money is real." },
];

function Playbook({ doc }: { doc: StateDoc }) {
  const reqs = new Map<number, { r: Requirement; programs: string[] }>();
  for (const p of doc.programs) for (const r of [...p.inherited_requirements, ...p.requirements]) {
    const hit = reqs.get(r.id);
    if (hit) hit.programs.push(p.key); else reqs.set(r.id, { r, programs: [p.key] });
  }
  const notes = [...doc.notes.map((n) => ({ n, program: undefined as string | undefined })), ...doc.programs.flatMap((p) => p.notes.map((n) => ({ n, program: p.key })))];
  const phaseOfReq = (r: Requirement) => r.data.phase || (r.data.req_type === "registration" ? "registration" : "application");
  const phaseOfNote = (n: Rec) => n.data.phase || (n.data.category === "post_award" ? "post_award" : n.data.category === "eligibility" ? "before_nofo" : null);
  const loose = notes.filter(({ n }) => !phaseOfNote(n) && n.data.category !== "history" && !(n.data.category === "open_question" && n.data.resolved));

  return (
    <div>
      {PHASES.map((ph, i) => {
        const myReqs = [...reqs.values()].filter(({ r }) => phaseOfReq(r) === ph.key).sort((a, b) => Number(!!b.r.data.hard_gate) - Number(!!a.r.data.hard_gate) || (b.r.data.lead_time_days || 0) - (a.r.data.lead_time_days || 0));
        const myNotes = notes.filter(({ n }) => phaseOfNote(n) === ph.key);
        return (
          <Card key={ph.key} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 4 }}>
              <span className="mono" style={{ color: "var(--olive-ink)", fontWeight: 600, fontSize: 13 }}>{String(i + 1).padStart(2, "0")}</span>
              <h3 className="serif" style={{ margin: 0, fontSize: 21, fontWeight: 500, color: "var(--ink)" }}>{ph.title}</h3>
            </div>
            <div style={{ fontSize: 14, color: "var(--sec)", marginBottom: 10 }}>{ph.blurb}</div>

            {ph.key === "submission" && doc.programs.filter((p) => !["dormant", "dead"].includes(p.data.status)).map((p) => {
              const next = p.cycles.flatMap((c) => c.deadlines.map((d) => ({ d, c }))).sort((a, b) => b.d.data.due_date.localeCompare(a.d.data.due_date))[0];
              return (
                <div key={p.id} style={{ fontSize: 14, padding: "8px 0", borderBottom: "1px solid var(--hair2)" }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--navy)", marginRight: 8 }}>{p.key}</span>
                  {p.data.submission?.method || "method not recorded"}{p.data.submission?.target ? ` via ${p.data.submission.target}` : ""}
                  {next && <span style={{ color: "var(--sec)" }}> · last known deadline {fmtDay(next.d.data.due_date)}{next.d.data.due_time ? `, ${fmtTime(next.d.data.due_time, next.d.data.tz)}` : ""} ({next.c.title})</span>}
                </div>
              );
            })}
            {ph.key === "post_award" && doc.jurisdiction?.data.post_award_note && <Markdown>{doc.jurisdiction.data.post_award_note}</Markdown>}

            {myReqs.length > 0 && <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{myReqs.map(({ r, programs }) => <RequirementRow key={r.id} r={{ ...r, inherited_from: undefined, data: { ...r.data, format: [r.data.format, programs.join(", ")].filter(Boolean).join(" · ") } }} />)}</ul>}
            {myNotes.length > 0 && <div style={{ display: "grid", gap: 8, marginTop: 12 }}>{myNotes.map(({ n, program }) => <NoteCard key={n.id} n={n} program={program} />)}</div>}
            {!myReqs.length && !myNotes.length && ph.key !== "submission" && !(ph.key === "post_award" && doc.jurisdiction?.data.post_award_note) && <div style={{ fontSize: 13 }}><Faint>Nothing recorded for this phase yet.</Faint></div>}
          </Card>
        );
      })}
      {loose.length > 0 && (
        <Card>
          <h3 className="serif" style={{ margin: "0 0 4px", fontSize: 21, fontWeight: 500, color: "var(--ink)" }}>Throughout</h3>
          <div style={{ fontSize: 14, color: "var(--sec)", marginBottom: 10 }}>Notes nobody has pinned to a phase yet.</div>
          <div style={{ display: "grid", gap: 8 }}>{loose.map(({ n, program }) => <NoteCard key={n.id} n={n} program={program} />)}</div>
        </Card>
      )}
    </div>
  );
}

/* ── History: who changed what ──────────────────────────────────── */

const show = (v: unknown) => (v === undefined || v === null || v === "" ? "nothing" : typeof v === "object" ? JSON.stringify(v) : String(v));
const ACTION: Record<string, string> = { create: "added", update: "changed", verify: "verified", unverify: "unverified", archive: "archived", restore: "restored", revert: "reverted", import: "imported" };
// How the change came in. "key" is a caller the backend could only name by its API
// key — a script, or the toolbox before it could say who was logged in — and reads
// as that rather than as the bare word "key" wedged between a name and a verb.
const HOW: Record<string, string> = { user: "in the toolbox", mcp: "via Claude", import: "by import", system: "automatically", key: "through the API" };

function History({ code, onChanged }: { code: string; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const [working, setWorking] = useState<number | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  async function revert(r: Revision) {
    const ok = await confirm(r.action === "create"
      ? { title: `Undo adding “${r.title}”?`, body: "It will be archived, and can be restored from History.", confirmLabel: "Undo" }
      : { title: `Put “${r.title}” back?`, body: `It goes back to how it was before ${r.actor} ${ACTION[r.action] || r.action} it.`, confirmLabel: "Revert" });
    if (!ok) return;
    setWorking(r.id); setErr(null);
    try {
      const cur = await gkGet<Rec>(`records/${r.record_id}`);
      await gkSend("POST", `revisions/${r.id}/revert`, { version: cur.version });
      setTick((t) => t + 1); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setWorking(null); }
  }
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [imports, setImports] = useState(false);
  useEffect(() => {
    let live = true;
    gkGet<{ revisions: Revision[] }>(`jurisdictions/${code}/revisions?limit=200`).then((d) => live && setRevs(d.revisions)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [code, tick]);
  if (err && !revs) return <Note>{err}</Note>;
  if (!revs) return <Skeleton rows={5} />;
  const importCount = revs.filter((r) => r.action === "import").length;
  const rows = revs.filter((r) => imports || r.action !== "import");
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <Eyebrow>Every change, newest first</Eyebrow>
        {importCount > 0 && <button onClick={() => setImports(!imports)} style={linkBtn}>{imports ? "Hide" : "Show"} the {importCount} import rows</button>}
      </div>
      {err && <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {!rows.length && <div style={{ fontSize: 14, color: "var(--sec)" }}>Nobody has edited this state since it was imported.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--hair2)" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
            <b style={{ color: "var(--ink)", fontWeight: 600 }}>{r.actor.startsWith("import:") ? "The import" : r.actor}</b>
            <span style={{ color: "var(--mute)", fontSize: 13 }}>{HOW[r.actor_kind] || r.actor_kind}</span>
            <span style={{ color: "var(--sec)" }}>{ACTION[r.action] || r.action}</span>
            <a href={`#rec-${r.record_id}`} style={{ color: "var(--navy)" }}>{r.title}</a>
            <Tag>{r.kind}</Tag>
            {r.action !== "import" && <button onClick={() => revert(r)} disabled={working === r.id} className="btn btn-quiet btn-sm" style={{ marginLeft: "auto", height: 28 }}>{working === r.id ? "Reverting…" : "Revert"}</button>}
            <span className="num" style={{ fontSize: 13, color: "var(--mute)", marginLeft: r.action === "import" ? "auto" : 0 }}>{new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </div>
          {r.reason && <div style={{ fontSize: 13, color: "var(--sec)", marginTop: 3 }}>“{r.reason}”</div>}
          {r.action === "update" && r.changed_fields.filter((f) => !f.startsWith("@")).map((f) => (
            <div key={f} className="mono" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5, wordBreak: "break-word" }}>
              <span style={{ color: "var(--mute)" }}>{f}: </span>
              <span style={{ color: "var(--err-fg)", textDecoration: "line-through" }}>{show(r.before?.data[f]).slice(0, 220)}</span>{" → "}
              <span style={{ color: "var(--ok-fg)" }}>{show(r.after.data[f]).slice(0, 220)}</span>
            </div>
          ))}
        </div>
      ))}
      {confirmDialog}
    </Card>
  );
}

/* ── The page for one jurisdiction ──────────────────────────────── */

type View = "overview" | "playbook" | "history";

export default function StatePage({ code, onBack }: { code: string; onBack: () => void }) {
  const [confirm, confirmDialog] = useConfirm();
  const [doc, setDoc] = useState<StateDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const narrow = useMedia("(max-width: 760px)");
  const reload = () => setTick((t) => t + 1);

  useEffect(() => { setDoc(null); setErr(null); setView("overview"); setEditing(false); setFlash(null); }, [code]);
  // After a save the page is fetched again rather than patched in place: a record can
  // move other things (a deadline moves the countdown, a verify moves the counts).
  useEffect(() => {
    let live = true;
    gkGet<StateDoc>(`jurisdictions/${code}`).then((d) => live && setDoc(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [code, tick]);

  async function move(rec: Rec, action: "verify" | "unverify" | "archive" | "restore") {
    setFlash(null);
    try { await gkSend("POST", `records/${rec.id}/${action}`, { version: rec.version }); }
    catch (e) { setFlash(e instanceof GkError && e.status === 409 ? `"${rec.title}" was changed by ${e.current?.updated_by || "someone"} a moment ago. The page has been refreshed; look again before you ${action}.` : (e as Error).message); }
    reload();
  }
  async function verifyAll(records: Rec[]) {
    const ok = await confirm({
      title: `Verify ${records.length} record${records.length === 1 ? "" : "s"} in ${code}?`,
      body: "They'll be marked as verified by you. Do this only for what you have checked yourself.",
      confirmLabel: `Verify ${records.length}`,
    });
    if (!ok) return;
    setFlash(null);
    try {
      const r = await gkSend<{ verified: number; failed: number }>("POST", `jurisdictions/${code}/verify-bulk`, { ids: records.map((x) => ({ id: x.id, version: x.version })) });
      if (r.failed) setFlash(`${r.verified} verified. ${r.failed} had changed in the meantime and were left alone.`);
    } catch (e) { setFlash((e as Error).message); }
    reload();
  }

  // A deep link to one record (#rec-123, #program-SCAHC) lands once the page has drawn.
  // Also on a hash change without a reload (one program's link to another), which
  // the browser scrolls to on its own but does not unfold.
  useEffect(() => {
    if (!doc) return;
    const reveal = () => {
      if (!window.location.hash) return;
      const el = document.getElementById(window.location.hash.slice(1));
      if (!el) return;
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [doc]);

  const allNotes = useMemo(() => (doc ? [...doc.notes.map((n) => ({ n, program: undefined as string | undefined })), ...doc.programs.flatMap((p) => p.notes.map((n) => ({ n, program: p.key })))] : []), [doc]);

  if (err) return <div><BackLink onBack={onBack} /><Note>{err}</Note></div>;
  if (!doc) return <div><BackLink onBack={onBack} /><Skeleton rows={6} style={{ padding: "16px 0" }} /></div>;

  const j = doc.jurisdiction?.data || {};
  const stoppers = allNotes.filter(({ n }) => n.data.severity === "auto_disqualifier");
  const portal = doc.programs.map((p) => p.data.submission?.url).find(Boolean);
  const nd = doc.next_deadline;
  const f = doc.freshness;
  const empty = !doc.jurisdiction && !doc.programs.length;
  const sources = [...doc.sources, ...doc.programs.flatMap((p) => p.sources)];
  const everything: Rec[] = [doc.jurisdiction, ...doc.programs.flatMap((p) => [p, ...p.requirements, ...p.cycles.flatMap((c) => [c, ...c.deadlines]), ...p.contacts, ...p.notes, ...p.sources]), ...doc.contacts, ...doc.notes, ...doc.sources].filter(Boolean) as Rec[];
  const toVerify = everything.filter((r) => r.effective_status !== "verified" || r.unverified_fields.length);

  return (
    <EditContext.Provider value={{ on: editing, open: setTarget, move, home: doc.code }}>
    <div>
      {target && <RecordEditor target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); reload(); }} />}
      <BackLink onBack={onBack} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 18, flexWrap: "wrap", marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <Eyebrow color="var(--olive)" style={{ marginBottom: 8 }}>{String(doc.jurisdiction_kind).charAt(0).toUpperCase() + String(doc.jurisdiction_kind).slice(1)} · {doc.code}{j.saa_short ? ` · ${String(j.saa_short)}` : ""}</Eyebrow>
          <h1 className="headline" style={{ margin: 0 }}>{doc.name}</h1>
          {j.saa && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 15, color: "var(--sec)", marginTop: 8 }}>{j.saa}{doc.jurisdiction && <><Trust rec={doc.jurisdiction} quiet /><RecActions rec={doc.jurisdiction} /></>}</div>}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <SegPill<View> label="View" options={[{ key: "overview", label: "Overview" }, { key: "playbook", label: "Playbook" }, { key: "history", label: "History" }]} value={view} onChange={setView} />
          <Button variant={editing ? "primary" : "secondary"} onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit"}</Button>
        </div>
      </div>

      {flash && <div role="alert" style={{ border: "1px solid var(--warn-fg)", background: "var(--warn-bg)", color: "var(--ink)", borderRadius: "var(--r-md)", padding: "10px 14px", fontSize: 14, marginBottom: 14 }}>{flash}</div>}
      {editing && (
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", border: "1px dashed var(--line-strong)", borderRadius: "var(--r-md)", padding: "10px 14px", marginBottom: 16, fontSize: 14, color: "var(--sec)" }}>
          <span>Add to {doc.name}:</span>
          {!doc.jurisdiction && <AddButton spec={{ jurisdiction: doc.code, kind: "jurisdiction", heading: `Start ${doc.name}'s record` }}>the state record</AddButton>}
          <AddButton spec={{ jurisdiction: doc.code, kind: "program", preset: { type: "state", status: "active" } }}>program</AddButton>
          <AddButton spec={{ jurisdiction: doc.code, kind: "contact", preset: { contact_kind: "saa" } }}>contact</AddButton>
          <AddButton spec={{ jurisdiction: doc.code, kind: "note", preset: { category: "gotcha" } }}>note or gotcha</AddButton>
          <AddButton spec={{ jurisdiction: doc.code, kind: "source" }}>source</AddButton>
          {toVerify.length > 0 && <Button variant="secondary" size="sm" onClick={() => verifyAll(toVerify)} style={{ marginLeft: "auto" }}>Verify all {toVerify.length} unconfirmed</Button>}
        </div>
      )}

      {empty ? (
        <Card><div style={{ fontSize: 14, color: "var(--sec)" }}>Nothing has been recorded for {doc.name} yet.{!editing && " Press Edit to start it."}</div></Card>
      ) : (
        <>
          {/* One strip, three cells, sized to what is in it: separate cards stretched to the tallest one and read as three half-empty boxes. */}
          <Card style={{ padding: 0, marginBottom: 16, display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.2fr)" }}>
            <div style={{ padding: "14px 18px" }}>
              <Stat label={nd ? "Next deadline" : "Where the cycle stands"} value={nd
                ? <>{fmtDay(nd.due_date)}{nd.due_time ? ` · ${fmtTime(nd.due_time, nd.tz)}` : ""} <span style={{ color: nd.days_away <= 14 ? "var(--err-fg)" : "var(--olive-ink)", fontWeight: 600 }}>· {countdown(nd.days_away)}</span></>
                : CYCLE_LABEL[doc.cycle_state]}
                note={nd ? `${nd.program} · ${nd.label}${nd.status !== "verified" ? " · unverified" : ""}` : doc.cycle_state === "closed" ? "The last recorded deadline has passed; no date for the next cycle yet." : j.cycle_status} />
            </div>
            <div style={{ padding: "14px 18px", borderLeft: narrow ? undefined : "1px solid var(--hair2)", borderTop: narrow ? "1px solid var(--hair2)" : undefined }}>
              <Stat label="How much is confirmed" value={`${f.verified} of ${f.records}`} note={[f.unverified ? `${f.unverified} unverified` : "", f.stale ? `${f.stale} stale` : "", doc.open_questions ? `${doc.open_questions} open question${doc.open_questions === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Everything has a verifier"} />
            </div>
            <div style={{ padding: "14px 18px", borderLeft: narrow ? undefined : "1px solid var(--hair2)", borderTop: narrow ? "1px solid var(--hair2)" : undefined }}>
              <Stat label="Portal" value={portal ? <a href={portal} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)", wordBreak: "break-word", fontSize: 14 }}>{portal.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a> : <Faint>None recorded</Faint>} note={j.urban_areas?.length ? `Urban areas: ${j.urban_areas.join("; ")}` : undefined} />
            </div>
          </Card>

          {/* Contacts and files: short, and wanted at the top, so they share a row under the strip. */}
          {view === "overview" && (doc.contacts.length > 0 || doc.files.length > 0 || editing) && (
            <div className="gk-pair" style={{ display: "grid", gridTemplateColumns: narrow || !(doc.contacts.length > 0 && (doc.files.length > 0 || editing)) ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, marginBottom: 16 }}>
              {/* Both open: the cards stretch to one height. One closed: they sit at their own heights. */}
              <style>{`.gk-pair { align-items: stretch; } .gk-pair:has(> .gk-card > details:not([open])) { align-items: start; }`}</style>
              {doc.contacts.length > 0 && (
                <Card className="gk-card" style={{ padding: "6px 24px", minWidth: 0 }}>
                  <Fold id="contacts" title="Contacts" meta={`${doc.contacts.length} on record`}><div className="gk-rows">{doc.contacts.map((c) => <ContactLine key={c.id} c={c} />)}</div></Fold>
                </Card>
              )}
              {(doc.files.length > 0 || editing) && (
                <Card className="gk-card" style={{ padding: "6px 24px", minWidth: 0 }}>
                  <Fold id="files" title="Files" meta={doc.files.length ? `${doc.files.length}` : undefined}><Files code={doc.code} files={doc.files} onChanged={reload} /></Fold>
                </Card>
              )}
            </div>
          )}

          {stoppers.length > 0 && view !== "history" && (
            <div role="note" style={{ border: "1px solid var(--err-line)", background: "var(--err-bg)", borderRadius: "var(--r-lg)", padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, color: "var(--err-fg)", marginBottom: 8 }}><AlertTriangle size={16} strokeWidth={2} aria-hidden />Read first: these end an application</div>
              {stoppers.map(({ n, program }) => (
                <div key={n.id} style={{ fontSize: 14, color: "var(--ink)", lineHeight: 1.5, marginBottom: 6 }}>
                  <a href={`#rec-${n.id}`} style={{ color: "var(--ink)", fontWeight: 600 }}>{n.data.title}</a>{program ? ` (${program})` : ""}{n.effective_status !== "verified" ? " · unverified" : ""}
                </div>
              ))}
            </div>
          )}

          {view === "overview" && (
            <>
              {(j.summary_md || j.partner || j.cycle_timing_note) && (
                <Card style={{ marginBottom: 16 }}>
                  <Eyebrow style={{ marginBottom: 8 }}>In short</Eyebrow>
                  {j.summary_md && <Markdown>{j.summary_md}</Markdown>}
                  {j.cycle_timing_note && <Markdown>{j.cycle_timing_note}</Markdown>}
                  {j.partner && <div style={{ fontSize: 14, color: "var(--sec)" }}><b style={{ fontWeight: 600 }}>Partner:</b> {j.partner}</div>}
                </Card>
              )}
              {doc.programs.map((p) => <ProgramCard key={p.id} p={p} />)}


              {CATEGORY_ORDER.map((cat) => {
                const mine = allNotes.filter(({ n }) => n.data.category === cat && !(cat === "open_question" && n.data.resolved)).sort((a, b) => SEVERITY_RANK.indexOf(a.n.data.severity) - SEVERITY_RANK.indexOf(b.n.data.severity));
                if (!mine.length) return null;
                return <Section key={cat} id={`notes-${cat}`} title={CATEGORY[cat]} meta={`${mine.length}`}><div style={{ display: "grid", gap: 9 }}>{mine.map(({ n, program }) => <NoteCard key={n.id} n={n} program={program} />)}</div></Section>;
              })}

              {(j.post_award_note) && <Section title="After the award"><Markdown>{j.post_award_note}</Markdown></Section>}


              {sources.length > 0 && (
                <Section id="sources" title="Sources" meta={`${sources.length}`}>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
                    {sources.map((s) => <li key={s.id} id={`rec-${s.id}`}><a href={s.data.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)", wordBreak: "break-word" }}>{s.data.title || String(s.data.url).replace(/^https?:\/\/(www\.)?/, "")}</a>{s.data.accessed && <span style={{ color: "var(--mute)", fontSize: 13 }}> · read {fmtDay(s.data.accessed)}</span>} <RecActions rec={s} /></li>)}
                  </ul>
                </Section>
              )}
            </>
          )}
          {view === "playbook" && <Playbook doc={doc} />}
          {view === "history" && <History code={doc.code} onChanged={reload} />}
        </>
      )}
      {confirmDialog}
    </div>
    </EditContext.Provider>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return <button onClick={onBack} className="btn btn-quiet btn-sm" style={{ marginBottom: 16, marginLeft: -10 }}><ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> All states</button>;
}
