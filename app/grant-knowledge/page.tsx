"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { Page, PageHeading, SectionHeader, Card, Eyebrow, SegPill, Note, Skeleton } from "../../components/ui";
import { JURISDICTIONS, SMALL_ON_MAP, OFF_MAP, jurisdiction, slugFromUsps, uspsFromSlug } from "../../lib/states";
import { useMedia } from "../../lib/useMedia";
import StatePage from "../../components/gk/StatePage";
import Queue from "../../components/gk/Queue";
import { gkGet, fmtDay, fmtTime, countdown, CYCLE_LABEL, type OverviewRow, type Attention, type Revision, type SearchHit } from "../../components/gk/api";

const StateMap = dynamic(() => import("../../components/StateMap"), { ssr: false });

/* ── What a colour means ────────────────────────────────────────── */

type Mode = "deadlines" | "freshness" | "money";
type Swatch = { color: string; dashed?: boolean; label: string };

/**
 * Two hues, as everywhere else in the toolbox: olive is the good end, navy the
 * middle, the track colour is "nothing here". Amber appears only for stale.
 * A closed cycle is a navy tint rather than the track colour: for most of the year
 * every state is closed, and "we know when it closed" is not "we know nothing".
 */
const CLOSED = "color-mix(in srgb, var(--navy) 24%, var(--track))";
function paint(mode: Mode, row?: OverviewRow): Swatch {
  if (!row || !row.freshness.records) return { color: "var(--track)", dashed: true, label: "Nothing recorded" };
  if (mode === "deadlines") {
    if (row.cycle_state === "open") return { color: "var(--olive)", label: "Open now" };
    if (row.cycle_state === "soon") return { color: "var(--navy)", label: "Coming up" };
    if (row.cycle_state === "closed") return { color: CLOSED, label: "Closed" };
    return { color: "var(--track)", dashed: true, label: "No dates recorded" };
  }
  if (mode === "freshness") {
    if (row.freshness.stale) return { color: "var(--warn-fg)", label: "Has stale facts" };
    if (row.freshness.unverified || row.freshness.fields_to_confirm) return { color: "var(--navy)", label: "Has unverified facts" };
    return { color: "var(--olive)", label: "All verified" };
  }
  if (row.has_state_program) return { color: "var(--olive)", label: "Active state program" };
  if (row.programs.some((p) => p.type === "state")) return { color: "var(--navy)", label: "Dormant or unconfirmed" };
  return { color: "var(--track)", label: "Federal only" };
}

const LEGEND: Record<Mode, Swatch[]> = {
  deadlines: [{ color: "var(--olive)", label: "Open now" }, { color: "var(--navy)", label: "Coming up" }, { color: CLOSED, label: "Closed" }, { color: "var(--track)", dashed: true, label: "No dates recorded" }],
  freshness: [{ color: "var(--olive)", label: "All verified" }, { color: "var(--navy)", label: "Has unverified facts" }, { color: "var(--warn-fg)", label: "Has stale facts" }],
  money: [{ color: "var(--olive)", label: "Active state program" }, { color: "var(--navy)", label: "Dormant or unconfirmed" }, { color: "var(--track)", label: "Federal only" }],
};

/* ── Search: a state by name, or anything written in one ────────── */

function SearchBox({ rows, onPick }: { rows: OverviewRow[]; onPick: (code: string, recordId?: number) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const places = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.code.toLowerCase() === s || r.saa_short.toLowerCase().includes(s)).slice(0, 6);
  }, [q, rows]);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 3) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => gkGet<{ hits: SearchHit[] }>(`search?q=${encodeURIComponent(s)}`).then((d) => live && setHits(d.hits.slice(0, 12))).catch(() => live && setHits([])), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const options = [...places.map((p) => ({ code: p.code, id: undefined as number | undefined })), ...hits.map((h) => ({ code: h.jurisdiction, id: h.record_id }))];
  const pick = (i: number) => { const o = options[i]; if (o) { setOpen(false); setQ(""); onPick(o.code, o.id); } };

  return (
    <div ref={box} style={{ position: "relative", width: "100%", maxWidth: 440 }}>
      <Search size={16} strokeWidth={1.75} aria-hidden style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--mute)", pointerEvents: "none" }} />
      <input
        type="search"
        className="field"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setAt(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter") pick(at);
          else if (e.key === "Escape") setOpen(false);
        }}
        role="combobox" aria-expanded={open && options.length > 0} aria-controls="gk-search-list" aria-label="Search states and everything recorded in them"
        placeholder="Find a state, a portal, a contact, a gotcha…"
        style={{ height: 40, paddingLeft: 36 }}
      />
      {open && options.length > 0 && (
        <div id="gk-search-list" role="listbox" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 50, background: "var(--raised)", border: "1px solid var(--bd2)", borderRadius: 12, boxShadow: "var(--shadow-pop)", maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {places.map((p, i) => (
            <div key={p.code} role="option" aria-selected={at === i} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }} style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: at === i ? "var(--hover)" : undefined, display: "flex", gap: 10, alignItems: "baseline" }}>
              <span className="mono" style={{ fontSize: 12, color: "var(--olive-ink)", width: 22 }}>{p.code}</span>
              <span style={{ color: "var(--ink)", fontSize: 14 }}>{p.name}</span>
              <span style={{ color: "var(--mute)", fontSize: 13 }}>{p.saa_short}</span>
            </div>
          ))}
          {hits.length > 0 && <div className="menu-label">Found in a state’s records</div>}
          {hits.map((h, hi) => {
            const i = places.length + hi;
            return (
              <div key={h.record_id} role="option" aria-selected={at === i} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }} style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: at === i ? "var(--hover)" : undefined }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--olive-ink)", width: 22 }}>{h.jurisdiction}</span>
                  <span style={{ color: "var(--ink)", fontSize: 14, fontWeight: 500 }}>{h.title}</span>
                  <span style={{ fontSize: 12, color: "var(--mute)" }}>{h.kind}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--mute)", marginLeft: 30, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.snippet}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── The landing view ───────────────────────────────────────────── */

function Chip({ row, code, swatch, onPick }: { row?: OverviewRow; code: string; swatch: Swatch; onPick: (c: string) => void }) {
  const dark = swatch.color !== "var(--track)" && swatch.color !== CLOSED;
  return (
    <button onClick={() => onPick(code)} title={`${jurisdiction(code)?.name}: ${swatch.label}${row?.saa_short ? ` · ${row.saa_short}` : ""}`} className="mono"
      style={{ padding: "6px 0", width: 44, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", color: dark ? "var(--on-accent)" : "var(--sec)", background: swatch.color, border: swatch.dashed ? "1px dashed var(--field)" : "1px solid transparent" }}>
      {code}
    </button>
  );
}

function Landing({ rows, onPick, onQueue }: { rows: OverviewRow[]; onPick: (code: string, recordId?: number) => void; onQueue: () => void }) {
  const [mode, setMode] = useState<Mode>("deadlines");
  const [showMap, setShowMap] = useState(false);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [recent, setRecent] = useState<Revision[]>([]);
  const narrow = useMedia("(max-width: 760px)");
  const byCode = useMemo(() => new Map(rows.map((r) => [r.code, r])), [rows]);
  const rowOf = (slug: string) => byCode.get(uspsFromSlug(slug) || "");

  useEffect(() => {
    let live = true;
    gkGet<Attention>("needs-attention?days=45").then((d) => live && setAttention(d)).catch(() => {});
    gkGet<{ revisions: Revision[] }>("revisions?limit=40").then((d) => live && setRecent(d.revisions.filter((r) => r.action !== "import").slice(0, 8))).catch(() => {});
    return () => { live = false; };
  }, []);

  const loaded = rows.some((r) => r.freshness.records > 0);
  const counts = attention?.counts;
  const mapVisible = !narrow || showMap;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 18, flexWrap: "wrap", marginBottom: 22 }}>
        <PageHeading description="What NSGP and the state programs require in all 50 states, DC, the five territories and the federal program, and when.">
          Grant Knowledge
        </PageHeading>
        <SearchBox rows={rows} onPick={onPick} />
      </div>

      {!loaded && <Note>The knowledge base is empty. Once the import has run, every state will have its SAA, programs, requirements, deadlines, contacts and gotchas here.</Note>}

      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Eyebrow>Color by</Eyebrow>
            <SegPill<Mode> size="sm" label="Color by" options={[{ key: "deadlines", label: "Deadlines" }, { key: "freshness", label: "Freshness" }, { key: "money", label: "State money" }]} value={mode} onChange={setMode} />
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {LEGEND[mode].map((s) => (
              <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--sec)" }}>
                <span style={{ width: 11, height: 11, borderRadius: 3, background: s.color, border: s.dashed ? "1px dashed var(--field)" : undefined, display: "inline-block" }} />{s.label}
              </span>
            ))}
          </div>
        </div>

        {narrow && <button onClick={() => setShowMap(!showMap)} style={{ background: "none", border: "none", color: "var(--navy)", fontSize: 13, fontWeight: 500, padding: "4px 0 10px", cursor: "pointer" }}>{showMap ? "Hide the map" : "Show the map"}</button>}

        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0, 1fr) 176px", gap: 22, alignItems: "start" }}>
          {mapVisible && (
            <StateMap
              colorFor={(slug) => paint(mode, rowOf(slug)).color}
              dashed={(slug) => !!paint(mode, rowOf(slug)).dashed}
              onSelect={(slug) => { const c = uspsFromSlug(slug); if (c) onPick(c); }}
              ariaLabelFor={(slug) => { const r = rowOf(slug); return `${r?.name || slug}: ${paint(mode, r).label}`; }}
              renderTooltip={(slug) => {
                const r = rowOf(slug);
                if (!r) return null;
                const nd = r.next_deadline;
                return (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{r.name}</div>
                    {r.saa_short && <div style={{ opacity: 0.85, fontSize: 12, marginBottom: 6 }}>{r.saa_short}</div>}
                    <div style={{ fontSize: 12, marginBottom: 3 }}>{nd ? `${nd.label}: ${fmtDay(nd.due_date, { month: "short", day: "numeric" })}, ${countdown(nd.days_away)}` : CYCLE_LABEL[r.cycle_state]}</div>
                    {r.programs.filter((p) => p.type === "state").map((p) => <div key={p.key} style={{ fontSize: 12, opacity: 0.9 }}>+ {p.key}{p.status !== "active" ? ` (${p.status})` : ""}</div>)}
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 5 }}>{r.freshness.verified} of {r.freshness.records} facts verified</div>
                  </>
                );
              }}
            />
          )}
          <div>
            {(narrow ? [["All states", JURISDICTIONS.filter((j) => j.kind === "state" || j.kind === "district").map((j) => j.usps)]] : [["Small on the map", SMALL_ON_MAP]]).concat([["Territories", OFF_MAP]]).map(([title, codes]) => (
              <div key={title as string} style={{ marginBottom: 14 }}>
                <Eyebrow style={{ marginBottom: 7 }}>{title as string}</Eyebrow>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{(codes as string[]).map((c) => <Chip key={c} code={c} row={byCode.get(c)} swatch={paint(mode, byCode.get(c))} onPick={onPick} />)}</div>
              </div>
            ))}
            <button onClick={() => onPick("US")} className="row-hover" style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--bd2)", background: "var(--card)", cursor: "pointer", textAlign: "left" }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--olive-ink)", marginBottom: 2 }}>US</div>
              <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 500 }}>The federal program</div>
              <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--mute)" }}>NOFO history, the IJ form, what every state inherits</div>
            </button>
          </div>
        </div>
      </Card>

      {/* minmax(0, …) and minWidth: 0, or a long change line makes its column wider than the map card above. */}
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
        <Card style={{ minWidth: 0 }}>
          <SectionHeader
            title="Needs a person"
            actions={<button onClick={onQueue} className="btn btn-quiet btn-sm" style={{ color: "var(--navy)" }}>Open the queue <ArrowRight size={15} strokeWidth={1.75} aria-hidden /></button>}
            style={{ marginBottom: 12 }}
          />
          {counts ? (
            <>
              <div style={{ display: "flex", gap: "10px 26px", flexWrap: "wrap", marginBottom: 14 }}>
                {([["Unverified", counts.unverified], ["Stale", counts.stale], ["Open questions", counts.open_questions], ["Gaps", counts.missing]] as [string, number][]).map(([label, n]) => (
                  <div key={label}><div className="kpi" style={{ fontSize: 26, lineHeight: "32px", color: n ? "var(--ink)" : "var(--mute)" }}>{n}</div><div style={{ fontSize: 13, color: "var(--mute)", whiteSpace: "nowrap" }}>{label}</div></div>
                ))}
              </div>
              {attention!.deadlines_soon.length > 0 && <Eyebrow style={{ margin: "4px 0 6px" }}>Deadlines in the next 45 days</Eyebrow>}
              {attention!.deadlines_soon.slice(0, 6).map((d) => (
                <button key={d.record_id} onClick={() => onPick(d.jurisdiction, d.record_id)} style={rowBtn}>
                  <span className="mono" style={{ color: "var(--olive-ink)", width: 24, fontSize: 12, flexShrink: 0 }}>{d.jurisdiction}</span>
                  <span style={{ flex: 1, minWidth: 0, color: "var(--ink)" }}>{d.program} · {d.label}</span>
                  <span style={{ color: d.days_away <= 14 ? "var(--err-fg)" : "var(--sec)", whiteSpace: "nowrap" }}>{fmtDay(d.due_date, { month: "short", day: "numeric" })}{d.due_time ? `, ${fmtTime(d.due_time, d.tz)}` : ""}</span>
                </button>
              ))}
              {attention!.open_questions.slice(0, 5).map((q) => (
                <button key={q.record_id} onClick={() => onPick(q.jurisdiction, q.record_id)} style={rowBtn}>
                  <span className="mono" style={{ color: "var(--warn-fg)", width: 24, fontSize: 12 }}>{q.jurisdiction}</span>
                  <span style={{ flex: 1, color: "var(--sec)" }}>{q.title}</span>
                </button>
              ))}
            </>
          ) : <Skeleton rows={4} />}
        </Card>
        <Card style={{ minWidth: 0 }}>
          <SectionHeader title="Recent changes" style={{ marginBottom: 12, minHeight: 32 }} />
          {!recent.length && <div style={{ fontSize: 14, color: "var(--mute)" }}>Nobody has edited anything since the import.</div>}
          {recent.map((r) => (
            <button key={r.id} onClick={() => onPick(r.jurisdiction, r.record_id)} style={rowBtn}>
              <span className="mono" style={{ color: "var(--olive-ink)", width: 24, fontSize: 12, flexShrink: 0 }}>{r.jurisdiction}</span>
              <span style={{ flex: 1, minWidth: 0, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b style={{ fontWeight: 600 }}>{r.actor}</b>{r.actor_kind === "mcp" ? " via Claude" : ""} {r.action === "create" ? "added" : r.action === "update" ? "changed" : `${r.action}d`.replace("ed", "ed")} {r.title}</span>
              <span style={{ color: "var(--mute)", whiteSpace: "nowrap", fontSize: 13 }}>{fmtDay(r.created_at, { month: "short", day: "numeric" })}</span>
            </button>
          ))}
        </Card>
      </div>
    </>
  );
}
const rowBtn: React.CSSProperties = { display: "flex", gap: 10, alignItems: "baseline", width: "100%", minWidth: 0, padding: "9px 0", background: "none", border: "none", borderBottom: "1px solid var(--hair2)", cursor: "pointer", fontSize: 14, lineHeight: 1.45, textAlign: "left" };

/* ── The route ──────────────────────────────────────────────────── */

function GrantKnowledge() {
  const router = useRouter();
  const params = useSearchParams();
  const code = (params.get("state") || "").toUpperCase();
  const valid = code && jurisdiction(code) ? code : "";
  const queue = params.get("view") === "queue";
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    gkGet<{ jurisdictions: OverviewRow[] }>("overview").then((d) => live && setRows(d.jurisdictions)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, []);

  const go = (c: string, recordId?: number) => { router.push(`/grant-knowledge?state=${c}${recordId ? `#rec-${recordId}` : ""}`); };

  return (
    <Page>
      {valid ? <StatePage code={valid} onBack={() => router.push(queue ? "/grant-knowledge?view=queue" : "/grant-knowledge")} />
        : queue ? <Queue onOpen={(c, id) => router.push(`/grant-knowledge?view=queue&state=${c}${id ? `#rec-${id}` : ""}`)} onBack={() => router.push("/grant-knowledge")} />
        : err ? <Note>{err}</Note>
        : !rows ? <Skeleton rows={5} style={{ padding: "24px 0" }} />
        : <Landing rows={rows} onPick={go} onQueue={() => router.push("/grant-knowledge?view=queue")} />}
    </Page>
  );
}

// useSearchParams needs a Suspense boundary or `next build` fails the page.
export default function GrantKnowledgePage() {
  return <Suspense fallback={null}><GrantKnowledge /></Suspense>;
}
