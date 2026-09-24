"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Mail,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  Page,
  Card,
  PageHeading,
  Eyebrow,
  Bar,
  Note,
  Button,
  Skeleton,
  useConfirm,
  useToast,
  type ConfirmOptions,
} from "../../components/ui";

/*
 * Grant writing: every in-house NSGP client and where their intake stands.
 *
 * What Claude reads through clients_list / intake_status, drawn as a page. The
 * data comes from the Sales Toolbox backend through /api/clients (a keyed,
 * read-only proxy); registering, seeding and updating clients stay with the MCP
 * tools, where each write is confirmed and logged.
 *
 * The list takes the full width; a row opens the client in a dialog, because a
 * profile (link, facts, sections, a 24-item checklist, uploads, contacts) is
 * more than a side column can hold.
 */

type Contact = {
  name: string;
  email: string;
  role: string;
  phone?: string;
  side?: "npsa" | "client" | "reference";
  is_primary?: boolean;
  /** When we last emailed them the intake link. */
  welcomed_at?: string | null;
};

type Doc = { key: string; label: string; hint?: string; source?: "standard" | "state" | "program" | "custom" };

type AppStatus = "active" | "planned" | "submitted" | "awarded" | "not_awarded" | "withdrawn";
/** One application NPSA is writing: program, cycle, the sites it covers. */
type Application = { id: string; program: string; cycle: string; sites: number[]; status: AppStatus; name?: string; kind?: "federal" | "state"; label?: string; derived?: boolean };
type ProgramOption = { code: string; name: string; kind: "federal" | "state" };
const APP_STATUS_LABEL: Record<AppStatus, string> = { active: "writing now", planned: "later cycle", submitted: "submitted", awarded: "awarded", not_awarded: "not awarded", withdrawn: "withdrawn" };

type ClientRow = {
  id: number;
  slug: string;
  name: string;
  state: string;
  phase: number;
  status: "active" | "submitted" | "cancelled" | "closed";
  program_track: string;
  drive_folder_id: string;
  upload_folder_id: string;
  asana_project_gid: string;
  kickoff_date: string | null;
  notes: string;
  submitted_at: string | null;
  last_client_activity_at: string | null;
  intake_url: string;
  saa: string | null;
  contacts?: Contact[]; // present on the single-client route, not the list
  documents?: Doc[]; // the Documents-tab rows; single-client route only
  documents_customised?: boolean;
  /** Documents the team marked received outside the form (usually by email). */
  documents_received?: Record<string, { at: string; by: string; note: string }>;
  applications?: Application[]; // stored list; empty until the team sets one
  applications_set?: boolean;
  programs?: ProgramOption[]; // what this client's state can apply for
  core: { answered: number; total: number };
  checklist: { completed: number; total: number };
  filled_by: string;
};

type ChecklistItem = { stem: string; label: string; status: string; due: string; owner: string; note: string; application?: string | null; application_label?: string | null; side?: "client" | "npsa"; title?: string; prefix?: string };
type Upload = { id: number; key: string; label: string; filename: string; size_bytes: number; uploaded_at: string; drive_url: string | null };

/** Fetches a client upload with the login token and hands it to the browser as a download. Returns an error to show, or null. */
async function downloadUpload(slug: string, u: Upload): Promise<string | null> {
  const r = await fetch(`/api/clients/${slug}/uploads/${u.id}`, { headers: authHeaders() });
  if (!r.ok) return `Could not download ${u.filename} (HTTP ${r.status}).`;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url; a.download = u.filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return null;
}
type WishItem = { stem: string; label: string; priority: number | string; answered: number; total: number; cost?: number | null };
type SiteBudget = { items: number; ma: number; ma_on: boolean; ma_default: boolean; total: number; cap: number; room: number; uncosted: number };
type WishFacility = { facility: number; name: string; prioritized: number; details: { answered: number; total: number }; items: WishItem[]; budget?: SiteBudget };
type Status = {
  slug: string;
  filled_by: string;
  status_line: string;
  core: { answered: number; total: number };
  sections: { section: string; answered: number; total: number }[];
  /** Per facility: items with a priority set and how complete each is. Absent until the backend that reports it is deployed. */
  wish_list?: WishFacility[];
  /** One wish list per stored application, each against its own caps. */
  wish_lists?: { application: string; label: string; status: AppStatus; sites: number[]; prioritized: number; facilities: WishFacility[]; budget: { requested: number; cap: number; room: number } }[];
  /** Program rows with a name, out of the slots the page offers. */
  programs?: { listed: number; slots: number };
  /** What the client has asked for across sites, against the federal applicant cap. */
  budget?: { requested: number; cap: number; room: number; sites: number };
  checklist: { completed: number; total: number; not_applicable?: number; per_application?: number; items: ChecklistItem[] };
  uploads: Upload[];
  /** Stored applications, or ones derived from the Locations tab (derived: true) when none are set. */
  applications?: Application[];
  applications_set?: boolean;
};

/** What the list shows. The first four are the tiles above it. */
type View = "active" | "kickoff" | "quiet" | "submitted" | "all";
type Sort = "attention" | "name" | "save" | "intake";

/** The sections the client is asked to fill; matches CORE_SECTIONS on the backend. */
const CORE_SECTION = /^([1-5]\. |Locations$|Programs$|Uploads$)/;

const PHASE: Record<number, string> = { 1: "Sales", 2: "Grant writing", 3: "Compliance", 4: "Implementation" };

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "PATCH", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

/** "Board roster (PDF)" → "up_board_roster_pdf": the upload key the backend expects for a custom document. */
const docKeyFor = (label: string) => "up_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders(), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

const daysSince = (iso: string | null): number | null =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

const fmtDate = (iso: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", opts) : "";

/** Checklist dates arrive as M/D/YYYY from the form; show them short. */
const fmtDue = (s: string) => {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? fmtDate(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`) : s;
};

/** "Idaho Office of Emergency Management (IOEM)" → "IOEM" for the list; the full name stays in the dialog and the hover. */
const saaShort = (saa: string | null) => {
  if (!saa) return "—";
  const m = saa.match(/\(([^)]+)\)/);
  if (m) return m[1];
  // Agencies the reference lists without one.
  if (/^Illinois Emergency Management Agency/.test(saa)) return "IEMA-OHS";
  return saa;
};

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const lastSave = (row: { last_client_activity_at: string | null }) => {
  const d = daysSince(row.last_client_activity_at);
  return d === null ? "never" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return on;
}

/* ── Small pieces ─────────────────────────────────────────────── */

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function StatusChip({ status }: { status: ClientRow["status"] }) {
  const tone: Record<ClientRow["status"], string> = {
    active: "badge-run",
    submitted: "badge-ok",
    cancelled: "badge-err",
    closed: "badge-neutral",
  };
  return <span className={`badge badge-dot ${tone[status] || "badge-neutral"}`}>{cap(status)}</span>;
}

function PhaseChip({ phase }: { phase: number }) {
  return <span className="badge badge-outline" title={`Phase ${phase}`}>{phase} · {PHASE[phase] || "Unknown"}</span>;
}

const appSites = (a: Application) => (a.sites.length === 1 ? `site ${a.sites[0]}` : `sites ${a.sites.join(", ")}`);

/** "CSNSGP 2026-27 · site 1" chips; a later cycle is dashed, a closed one faded. */
function AppChips({ apps, size = "sm" }: { apps: Application[]; size?: "sm" | "md" }) {
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
      {apps.map((a) => {
        const later = a.status === "planned";
        const closed = a.status === "not_awarded" || a.status === "withdrawn";
        return (
          <span
            key={a.id}
            title={`${a.name || a.program}${a.cycle ? ` · ${a.cycle}` : ""} · ${APP_STATUS_LABEL[a.status]}${a.derived ? " · from the Locations tab" : ""}`}
            className={`app-chip${size === "md" ? " app-chip-md" : ""}`}
            data-kind={later || a.derived ? "later" : closed ? "closed" : "active"}
          >
            <b>{a.label || [a.program, a.cycle].filter(Boolean).join(" ")}</b> · {appSites(a)}
            {a.status !== "active" && <span className="app-chip-status"> · {APP_STATUS_LABEL[a.status]}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** Where a client's own work stands, from their last save. Status words carry it, not color alone. */
function saveState(row: { status: ClientRow["status"]; last_client_activity_at: string | null }) {
  const d = daysSince(row.last_client_activity_at);
  const when = d === null ? "Never saved" : d === 0 ? "Saved today" : d === 1 ? "Saved yesterday" : `Saved ${d} days ago`;
  if (row.status !== "active") return { d, when, tone: "", label: "" };
  if (d === null) return { d, when, tone: "badge-neutral", label: "No saves yet" };
  if (d > 30) return { d, when, tone: "badge-err", label: "Stalled" };
  if (d > 14) return { d, when, tone: "badge-warn", label: "Quiet" };
  return { d, when, tone: "badge-ok", label: "On track" };
}

function LastSave({ row, inline = false }: { row: ClientRow; inline?: boolean }) {
  const st = saveState(row);
  if (!st.label) return <span className="meta num">{st.when}</span>;
  return (
    <span style={{ display: "inline-flex", flexDirection: inline ? "row" : "column", alignItems: inline ? "center" : "flex-start", gap: inline ? 8 : 4 }}>
      <span className={`badge badge-dot ${st.tone}`}>{st.label}</span>
      {st.d !== null && <span className="meta num" style={{ whiteSpace: "nowrap" }}>{st.when}</span>}
    </span>
  );
}

function Progress({ a, b, width = 88 }: { a: number; b: number; width?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ width, display: "inline-block" }}>
        <Bar pct={pct(a, b)} color="var(--olive)" height={6} animate={false} />
      </span>
      <span className="num" style={{ fontSize: 13, color: "var(--sec)", minWidth: 52, whiteSpace: "nowrap" }}>
        {a} of {b}
      </span>
    </span>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--navy)", textDecoration: "none", fontWeight: 500 }}>
      {children}
    </a>
  );
}

const Faint = ({ children }: { children: React.ReactNode }) => <span style={{ color: "var(--mute)" }}>{children}</span>;

/** A text-link button for small actions inside a section: "Mark received", "Undo". */
const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, color: "var(--navy)", fontSize: 13, lineHeight: "18px", fontWeight: 500, cursor: "pointer" };

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="btn btn-quiet btn-sm btn-icon" style={{ width: 28, height: 28 }}>
      <X size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

const ErrorLine = ({ children }: { children: React.ReactNode }) => (
  <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, lineHeight: "18px", marginTop: 6 }}>{children}</div>
);

/* ── Team edits inside the dialog ─────────────────────────────── */

/** One titled block in the dialog: a title, an optional right-hand summary, then the content. */
function Section({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ paddingTop: 18, borderTop: "1px solid var(--hair)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: "var(--ink)" }}>{title}</h3>
        {meta && <span className="meta" style={{ whiteSpace: "nowrap" }}>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** A small headline number with a caption, for the strip under the dialog header. */
function Stat({ label, value, sub, bar, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; bar?: number; tone?: "ok" | "warn" | "err" }) {
  const color = tone === "err" ? "var(--err-fg)" : tone === "warn" ? "var(--warn-fg)" : "var(--ink)";
  return (
    <div style={{ padding: "12px 14px", background: "var(--bg)", border: "1px solid var(--hair)", borderRadius: 12, minWidth: 0 }}>
      <div className="eyebrow">{label}</div>
      <div className="serif num" style={{ fontSize: 24, lineHeight: "30px", fontWeight: 500, color, marginTop: 2 }}>{value}</div>
      {bar !== undefined && <div style={{ marginTop: 8 }}><Bar pct={Math.min(100, bar)} color={tone === "err" ? "var(--err-fg)" : "var(--olive)"} height={6} animate={false} /></div>}
      {sub && <div className="meta" style={{ marginTop: 6, overflowWrap: "anywhere" }}>{sub}</div>}
    </div>
  );
}

/** What NPSA is writing for this client. Everything on the client form (header, caps, documents) reads from this list. */
function ApplicationsSection({ client, derived, editing, onSaved }: { client: ClientRow; derived: Application[]; editing: boolean; onSaved: (c: ClientRow) => void }) {
  const stored = client.applications || [];
  const programs = client.programs || [];
  const seed = () => (stored.length ? stored : derived.filter((a) => a.program !== "NSGP")).map(({ id, program, cycle, sites, status }) => ({ id: client.applications_set ? id : "", program, cycle, sites, status }));
  const [draft, setDraft] = useState<Application[]>(seed);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (editing) setDraft(seed()); setErr(null); }, [editing, client]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = stored.length ? stored : derived;
  const set = (i: number, patch: Partial<Application>) => setDraft((d) => d.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const save = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchJson<ClientRow>(`/api/clients/${client.slug}`, { applications: draft.map(({ id, program, cycle, sites, status }) => ({ ...(id ? { id } : {}), program, cycle, sites, status })) })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed());
  if (!editing && client.applications_set && stored.length) return null; // the dialog header already shows them
  return (
    <Section title="Applications" meta={client.applications_set ? `${stored.length} set` : derived.length ? "from the Locations tab, not set" : "not set"}>
      {!editing && (shown.length ? <AppChips apps={shown} size="md" /> : <Faint>No applications set. Use Edit to add the programs and cycles we are writing.</Faint>)}
      {!editing && !client.applications_set && derived.length > 0 && <div className="meta" style={{ marginTop: 6 }}>Guessed from the client&rsquo;s &ldquo;Programs applying&rdquo; answers. Set them so the form&rsquo;s header, caps and documents follow.</div>}
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {draft.map((a, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto", gap: 8, alignItems: "center", padding: "10px 8px 10px 10px", border: "1px solid var(--hair)", borderRadius: 10, background: "var(--bg)" }}>
              <select value={a.program} onChange={(e) => set(i, { program: e.target.value })} aria-label="Program" className="field field-sm">
                {!programs.some((p) => p.code === a.program) && <option value={a.program}>{a.program || "Program…"}</option>}
                {programs.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}
              </select>
              <input value={a.cycle} onChange={(e) => set(i, { cycle: e.target.value })} placeholder="FY2027 / 2026-27" aria-label="Cycle" className="field field-sm" />
              <RemoveButton label="Remove application" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />
              <span style={{ display: "inline-flex", gap: 10, alignItems: "center", fontSize: 13, whiteSpace: "nowrap", color: "var(--sec)" }}>
                Sites
                {[1, 2, 3].map((n) => (
                  <label key={n} style={{ display: "inline-flex", gap: 3, alignItems: "center", cursor: "pointer", color: "var(--ink)" }}>
                    <input type="checkbox" checked={a.sites.includes(n)} onChange={(e) => set(i, { sites: e.target.checked ? [...a.sites, n].sort() : a.sites.filter((x) => x !== n) })} />
                    {n}
                  </label>
                ))}
              </span>
              <select value={a.status} onChange={(e) => set(i, { status: e.target.value as AppStatus })} aria-label="Status" className="field field-sm">
                {(Object.keys(APP_STATUS_LABEL) as AppStatus[]).map((k) => <option key={k} value={k}>{APP_STATUS_LABEL[k]}</option>)}
              </select>
              <span />
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="secondary" size="sm" icon={Plus} disabled={draft.length >= 6} onClick={() => setDraft((d) => [...d, { id: "", program: programs[0]?.code || "NSGP-S", cycle: "", sites: [1], status: "active" }])}>Add application</Button>
            <Button size="sm" busy={busy} disabled={busy || !dirty || draft.some((a) => !a.program || !a.sites.length)} onClick={save}>{busy ? "Saving…" : "Save applications"}</Button>
            <span className="meta">Sites are the Locations-tab site numbers. &ldquo;Later cycle&rdquo; shows on the form but stays out of today&rsquo;s caps.</span>
          </div>
        </div>
      )}
      {err && <ErrorLine>{err}</ErrorLine>}
    </Section>
  );
}

/** The Documents-tab rows with what has come in against each; editing adds remove, add and reset. */
function DocumentsSection({ client, uploads, editing, onSaved }: { client: ClientRow; uploads: Upload[]; editing: boolean; onSaved: (c: ClientRow) => void }) {
  const [label, setLabel] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState<string | null>(null);
  const docs = client.documents || [];
  const byKey = new Map<string, Upload[]>();
  for (const u of uploads) byKey.set(u.key, [...(byKey.get(u.key) || []), u]);
  const orphans = uploads.filter((u) => !docs.some((d) => d.key === u.key));
  const marks = client.documents_received || {};
  const received = docs.filter((d) => byKey.has(d.key) || marks[d.key]).length;
  const run = async (body: unknown) => {
    setBusy(true); setErr(null);
    try { onSaved(await patchJson<ClientRow>(`/api/clients/${client.slug}`, body)); setLabel(""); setHint(""); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const fileRow = (u: Upload) => (
    <div key={u.id} style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flexWrap: "wrap", marginTop: 4, fontSize: 13 }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>{u.filename}</span>
      <span className="num" style={{ color: "var(--mute)", whiteSpace: "nowrap" }}>{fmtDate(u.uploaded_at)}</span>
      {u.drive_url && <Ext href={u.drive_url}>Drive</Ext>}
      <Button variant="secondary" size="sm" icon={Download} onClick={async () => setDlErr(await downloadUpload(client.slug, u))} style={{ height: 28 }}>Download</Button>
    </div>
  );
  return (
    <Section title="Documents" meta={`${received} of ${docs.length} received${client.documents_customised ? " · customised" : ""}`}>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
        {docs.map((d) => {
          const files = byKey.get(d.key) || [];
          const mark = marks[d.key];
          const got = files.length > 0 || !!mark;
          return (
            <li key={d.key} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
              <span aria-hidden style={{ marginTop: 5, width: 10, height: 10, borderRadius: "50%", justifySelf: "center", border: `2px solid ${got ? "var(--ok-fg)" : "var(--line-strong)"}`, background: got ? "var(--ok-fg)" : "transparent" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--ink)" }}>{d.label}{got && <span className="meta"> · received</span>}</div>
                {!got && (
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 13, color: "var(--mute)" }}>
                    <span>Not received yet{d.hint ? ` · ${d.hint}` : ""}</span>
                    <button type="button" disabled={busy} onClick={() => run({ mark_documents_received: [d.key] })} title="They sent it another way, e.g. by email" style={linkBtn}>Mark received</button>
                  </div>
                )}
                {mark && files.length === 0 && (
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13, color: "var(--mute)" }}>
                    <span>{mark.note} · {fmtDate(mark.at)}</span>
                    <button type="button" disabled={busy} onClick={() => run({ unmark_documents_received: [d.key] })} style={linkBtn}>Undo</button>
                  </div>
                )}
                {files.map(fileRow)}
              </div>
              {editing ? <RemoveButton label={`Remove ${d.label} from the client's Documents tab`} disabled={busy} onClick={() => run({ remove_document_keys: [d.key] })} /> : <span />}
            </li>
          );
        })}
        {orphans.length > 0 && (
          <li style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr)", gap: 10 }}>
            <span />
            <div><div style={{ color: "var(--mute)", fontSize: 13 }}>Also uploaded, no longer asked for</div>{orphans.map(fileRow)}</div>
          </li>
        )}
      </ul>
      {editing && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto", gap: 8, marginTop: 12 }}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a document, e.g. Board roster" aria-label="Document label" className="field field-sm" />
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Hint (PDF, where to get it)" aria-label="Document hint" className="field field-sm" />
            <Button variant="secondary" size="sm" icon={Plus} disabled={busy || !label.trim()} onClick={() => run({ add_documents: [{ key: docKeyFor(label), label: label.trim(), hint: hint.trim() }] })}>Add</Button>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <span className="meta">These rows are the client&rsquo;s Documents tab. Files already uploaded stay either way.</span>
            {client.documents_customised && <button type="button" disabled={busy} onClick={() => run({ documents: null })} style={linkBtn}>Reset to defaults</button>}
          </div>
        </>
      )}
      {err && <ErrorLine>{err}</ErrorLine>}
      {dlErr && <ErrorLine>{dlErr}</ErrorLine>}
    </Section>
  );
}

/** Everyone around the application: the client's people, NPSA, and the helpful outside contacts (editable). */
function PeopleSection({ client, editing, onSaved, confirm, notify }: { client: ClientRow; editing: boolean; onSaved: (c: ClientRow) => void; confirm: (o: ConfirmOptions) => Promise<boolean>; notify: (m: string) => void }) {
  const [f, setF] = useState({ name: "", role: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const all = client.contacts || [];
  const own = all.filter((x) => x.side !== "npsa" && x.side !== "reference");
  const npsa = all.filter((x) => x.side === "npsa");
  const refs = all.filter((x) => x.side === "reference");
  const run = async (body: unknown) => {
    setBusy(true); setErr(null);
    try { onSaved(await patchJson<ClientRow>(`/api/clients/${client.slug}`, body)); setF({ name: "", role: "", email: "", phone: "" }); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  // Emails the client's own contact their intake link, sent as their grant writer.
  const invite = async (x: Contact) => {
    const who = x.name || x.email;
    const ok = await confirm({
      title: x.welcomed_at ? "Email the intake link again?" : "Email the intake link?",
      body: <>{who} ({x.email}) gets their personal link to the intake form, sent from you.{x.welcomed_at ? ` It last went out ${fmtDate(x.welcomed_at)}.` : ""}</>,
      confirmLabel: x.welcomed_at ? "Send it again" : "Send link",
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const fresh = await patchJson<ClientRow & { invite?: { sent: boolean; reason?: string } }>(`/api/clients/${client.slug}`, { invite_contact_email: x.email });
      onSaved(fresh);
      if (fresh.invite && !fresh.invite.sent) setErr(`Not sent: ${fresh.invite.reason}`);
      else notify(`Link sent to ${who}`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  // Rows wrap rather than truncate: a phone number cut to "(3…" is no use to anyone.
  const person = (x: Contact, removable = false, invitable = false) => (
    <div key={x.email} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "4px 0" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontSize: 14, lineHeight: "20px" }}>
          <span style={{ fontWeight: 600, color: "var(--ink)" }}>{x.name || x.email}</span>
          {x.role && <span style={{ color: "var(--sec)" }}> · {x.role}</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0 12px", fontSize: 13, lineHeight: "18px" }}>
          <a href={`mailto:${x.email}`} style={{ color: "var(--navy)", textDecoration: "none", overflowWrap: "anywhere" }}>{x.email}</a>
          {x.phone && <span className="num" style={{ color: "var(--sec)", whiteSpace: "nowrap" }}>{x.phone}</span>}
        </div>
      </div>
      {invitable && (
        <Button variant="secondary" size="sm" icon={Mail} disabled={busy} onClick={() => invite(x)} title={x.welcomed_at ? `Link emailed ${fmtDate(x.welcomed_at)}` : "Email them the intake link, as their grant writer"}>
          {x.welcomed_at ? "Re-send link" : "Email link"}
        </Button>
      )}
      {removable && <RemoveButton label={`Remove ${x.name || x.email}`} disabled={busy} onClick={() => run({ remove_contact_emails: [x.email] })} />}
    </div>
  );
  const sub = (t: string) => <div className="eyebrow" style={{ marginTop: 14, marginBottom: 4 }}>{t}</div>;
  return (
    <Section title="People" meta={`${own.length} at the client`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {own.length === 0 && <Faint>No client contacts on file yet.</Faint>}
        {own.map((x) => person(x, false, editing))}
      </div>
      {sub("NPSA")}
      <div style={{ fontSize: 14, color: "var(--sec)" }}>{npsa.map((x) => `${x.name.split(" ")[0]}${/consultant|sales rep/i.test(x.role) ? " (consultant)" : ""}`).join(", ") || <Faint>None</Faint>}</div>
      {(refs.length > 0 || editing) && sub("Helpful contacts: SAA, CISA")}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {refs.length === 0 && editing && <Faint>None yet. These show read-only on the client&rsquo;s Contacts tab.</Faint>}
        {refs.map((x) => person(x, editing))}
      </div>
      {editing && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
          <input value={f.name} onChange={set("name")} placeholder="Name" aria-label="Name" className="field field-sm" />
          <input value={f.role} onChange={set("role")} placeholder="Role, e.g. Texas SAA help desk" aria-label="Role" className="field field-sm" />
          <input value={f.email} onChange={set("email")} placeholder="Email" aria-label="Email" className="field field-sm" />
          <div style={{ display: "flex", gap: 8 }}>
            <input value={f.phone} onChange={set("phone")} placeholder="Phone" aria-label="Phone" className="field field-sm" />
            <Button variant="secondary" size="sm" icon={Plus} disabled={busy || !f.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)} onClick={() => run({ add_reference_contacts: [{ name: f.name.trim(), role: f.role.trim(), email: f.email.trim(), phone: f.phone.trim() }] })}>Add</Button>
          </div>
        </div>
      )}
      {err && <ErrorLine>{err}</ErrorLine>}
    </Section>
  );
}

/** The 24 tasks, open ones first; finished and not-applicable ones fold away behind a count. */
const CK_STATUS: [string, string][] = [["Not started", "To do"], ["In progress", "Working on it"], ["Completed", "Done"], ["Not applicable", "Doesn't apply"]];
/** "10/8/2026" or "2026-10-08" → "2026-10-08" for a date input; blank when unreadable. */
function toIsoDate(v: string): string {
  const s = String(v || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}
/** The client form's own format, which its checklist reads: M/D/YYYY. */
const fromIsoDate = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : ""; };
const isDayGuide = (n: string) => /^Day \d+/.test(n);

/** The bar across the top of a pane that takes over the dialog: back, what this is, unsaved state, save. */
function PaneHeader({ title, help, onBack, dirty, busy, onSave, saveLabel }: { title: string; help: React.ReactNode; onBack: () => void; dirty: boolean; busy: boolean; onSave: () => void; saveLabel: string }) {
  return (
    <div style={{ padding: "12px 26px", borderBottom: "1px solid var(--hair)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Button variant="quiet" size="sm" icon={ArrowLeft} onClick={onBack} style={{ marginLeft: -10 }}>Back to client</Button>
      <div style={{ flex: "1 1 320px", minWidth: 0 }}>
        <div style={{ fontSize: 16, lineHeight: "22px", fontWeight: 600, color: "var(--ink)" }}>{title}</div>
        <div className="meta">{help}</div>
      </div>
      {dirty && <span className="badge badge-dot badge-warn">Unsaved changes</span>}
      <Button size="sm" busy={busy} disabled={busy || !dirty} onClick={onSave}>{busy ? "Saving…" : saveLabel}</Button>
    </div>
  );
}

/** Asks before unsaved edits are thrown away. */
const discardPrompt = (what: string, verb: "Close" | "Leave"): ConfirmOptions => ({
  title: `${verb} without saving?`,
  body: `Your ${what} changes haven't been saved yet.`,
  confirmLabel: `${verb} without saving`,
  cancelLabel: "Keep editing",
  tone: "danger",
});

/**
 * The checklist editor: every task with its status, due date and note, the client's tasks first, then
 * NPSA's. The client form lets the client mark only their own tasks; NPSA's are updated here. A task set
 * to "Doesn't apply" shows its note to the client as the reason. Takes over the dialog like the notes pane.
 */
function ChecklistPane({ client, items, onClose, closeGuard, confirm }: { client: ClientRow; items: ChecklistItem[]; onClose: (saved: boolean) => void; closeGuard: React.MutableRefObject<(() => Promise<boolean>) | null>; confirm: (o: ConfirmOptions) => Promise<boolean> }) {
  const stacked = useMedia("(max-width: 900px)");
  const key = (it: ChecklistItem, f: string) => `${it.prefix || "chk_"}${f}_${it.stem}`;
  const initial = () => Object.fromEntries(items.flatMap((it) => [
    [key(it, "status"), it.status || "Not started"], [key(it, "due"), toIsoDate(it.due)], [key(it, "note"), isDayGuide(it.note) ? "" : it.note || ""],
  ]));
  const [base, setBase] = useState<Record<string, string>>(initial);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  // Notes open on demand. Most tasks have none, and two dozen empty boxes read as a form to fill in.
  const [noteOpen, setNoteOpen] = useState<Set<string>>(() => new Set());
  const changed = Object.keys(draft).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  closeGuard.current = async () => !dirty || (await confirm(discardPrompt("checklist", "Close")));
  useEffect(() => () => { closeGuard.current = null; }, [closeGuard]);
  const leave = async () => { if (dirty && !(await confirm(discardPrompt("checklist", "Leave")))) return; onClose(savedOnce); };
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const checklist = Object.fromEntries(changed.map((k) => [k, /_due_/.test(k) ? fromIsoDate(draft[k]) : draft[k]]));
      await patchJson(`/api/clients/${client.slug}`, { checklist });
      setBase(draft); setSavedOnce(true);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const byDue = (a: ChecklistItem, b: ChecklistItem) => (draft[key(a, "due")] || "9999").localeCompare(draft[key(b, "due")] || "9999");
  const groups: [string, string, ChecklistItem[]][] = [
    ["client", "The client's tasks", items.filter((it) => it.side !== "npsa").sort(byDue)],
    ["npsa", "NPSA's tasks", items.filter((it) => it.side === "npsa").sort(byDue)],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <PaneHeader
        title="Checklist"
        help={<>The client marks their own tasks on the form; NPSA&rsquo;s are set here. A &ldquo;Doesn&rsquo;t apply&rdquo; note is the reason the client sees.</>}
        onBack={leave} dirty={dirty} busy={busy} onSave={save} saveLabel="Save checklist"
      />
      <div style={{ overflowY: "auto", padding: "8px 26px 30px" }}>
        {err && <Note>{err}</Note>}
        {groups.map(([gk, title, list]) => (
          <section key={gk} style={{ marginTop: 20 }}>
            <Eyebrow style={{ marginBottom: 6 }}>{title} · {list.length}</Eyebrow>
            {list.map((it) => {
              const sk = key(it, "status"), dk = key(it, "due"), nk = key(it, "note");
              const na = draft[sk] === "Not applicable";
              const showNote = na || !!draft[nk] || noteOpen.has(nk);
              const subline = [it.application_label, it.title && it.title !== it.label ? it.label : ""].filter(Boolean).join(" · ");
              return (
                <div key={sk} style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "minmax(0, 1.4fr) 164px 164px minmax(0, 1.3fr)", gap: stacked ? 8 : 12, alignItems: "start", padding: "12px 0", borderTop: "1px solid var(--hair)" }}>
                  <div style={{ minWidth: 0, paddingTop: stacked ? 0 : 6 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)", lineHeight: "20px" }}>{it.title || it.label}</div>
                    {subline && <div className="meta">{subline}</div>}
                  </div>
                  <select value={draft[sk]} onChange={(e) => set(sk, e.target.value)} aria-label={`Status of ${it.label}`} className="field field-sm">
                    {CK_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input type="date" value={draft[dk]} onChange={(e) => set(dk, e.target.value)} aria-label={`Due date for ${it.label}`} className="field field-sm" />
                  {showNote ? (
                    <textarea value={draft[nk]} onChange={(e) => set(nk, e.target.value)} rows={na || draft[nk] ? 2 : 1}
                      autoFocus={noteOpen.has(nk) && !draft[nk] && !na}
                      placeholder={na ? "Why it doesn't apply (the client sees this)" : "Note the client sees under the task"}
                      aria-label={`Note on ${it.label}`} className="field field-sm"
                      style={na && !draft[nk] ? { borderColor: "var(--warn-fg)" } : undefined} />
                  ) : (
                    <button type="button" onClick={() => setNoteOpen((o) => new Set(o).add(nk))} style={{ ...linkBtn, display: "inline-flex", alignItems: "center", gap: 4, justifySelf: "start", paddingTop: stacked ? 0 : 7 }}>
                      <Plus size={14} strokeWidth={2} aria-hidden /> Add a note
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function ChecklistSection({ checklist, onEdit }: { checklist: Status["checklist"]; onEdit: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const open = checklist.items.filter((it) => it.status !== "Completed" && it.status !== "Not applicable");
  const rest = checklist.items.filter((it) => it.status === "Completed" || it.status === "Not applicable");
  // Prep tasks are shared; the wish list, budget, IJ and submission repeat per application.
  const groups: { key: string; label: string | null; items: ChecklistItem[] }[] = [];
  for (const it of open) {
    const key = it.application || "";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, label: it.application_label || null, items: [it] });
  }
  const row = (it: ChecklistItem, i: number) => {
    const done = it.status === "Completed";
    const prog = it.status === "In progress";
    const na = it.status === "Not applicable";
    const when = na ? "Doesn't apply" : done ? "Done" : [it.due ? `Due ${fmtDue(it.due)}` : "", it.owner].filter(Boolean).join(" · ");
    return (
      <li key={it.stem} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "7px 0", borderTop: i ? "1px solid var(--hair2)" : undefined, fontSize: 14 }}>
        <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", justifySelf: "center", border: `2px solid ${done ? "var(--ok-fg)" : prog ? "var(--warn-fg)" : "var(--line-strong)"}`, background: done ? "var(--ok-fg)" : prog ? "var(--warn-bg)" : na ? "var(--line-strong)" : "transparent", opacity: na ? 0.6 : 1 }} />
        <span style={{ minWidth: 0, color: done || na ? "var(--mute)" : "var(--ink)", lineHeight: "20px", textDecoration: na ? "line-through" : undefined }}>
          {it.label}
          {it.side === "npsa" && <span className="badge badge-outline" style={{ marginLeft: 8, height: 20, padding: "0 7px", verticalAlign: 1 }}>NPSA</span>}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
          {prog && <span className="badge badge-dot badge-warn">In progress</span>}
          {when && <span className="meta num">{when}</span>}
        </span>
      </li>
    );
  };
  return (
    <Section
      title="Checklist"
      meta={
        <>
          {open.length} left
          {rest.length > 0 ? (
            <>
              {" · "}
              <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} style={linkBtn}>
                {showDone ? "Hide" : "Show"} {checklist.completed} done{checklist.not_applicable ? ` and ${checklist.not_applicable} not applicable` : ""}
              </button>
            </>
          ) : " · nothing finished yet"}
        </>
      }
    >
      {open.length === 0 && <Faint>Every task is finished or marked not applicable.</Faint>}
      {groups.map((g) => (
        <div key={g.key}>
          {g.label && <Eyebrow style={{ marginTop: 12, marginBottom: 2 }}>{g.label}</Eyebrow>}
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{g.items.map(row)}</ul>
        </div>
      ))}
      {showDone && rest.length > 0 && (
        <ul style={{ margin: "10px 0 0", padding: "8px 0 0", listStyle: "none", borderTop: "1px dashed var(--line-strong)" }}>
          {rest.map((it, i) => (
            <li key={`${it.application || ""}-${it.stem}`} style={{ listStyle: "none" }}>
              {it.application_label && <div className="meta" style={{ marginTop: i ? 6 : 0 }}>{it.application_label}</div>}
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{row(it, 0)}</ul>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 12 }}>
        <Button variant="secondary" size="sm" onClick={onEdit}>Edit checklist</Button>
      </div>
    </Section>
  );
}

/** One row of the team answers read. */
type AnswerRow = { key: string; value: string; number?: string; prompt?: string; label: string };
const ellipsis = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
const NOTE_SECTIONS: Record<string, string> = { "2": "Your identity", "3": "Your role in the community", "4": "The threats you face", "5": "The project" };
type NotesData = { answer: Map<string, string>; notes: { key: string; q: string; number: string; prompt: string; note: string }[]; asks: string[] };
async function loadNotes(slug: string): Promise<NotesData> {
  const d = await getJson<{ answers: AnswerRow[] }>(`/api/clients/${slug}/answers?include_empty=1`);
  const answer = new Map(d.answers.map((r) => [r.key, r.value]));
  const notes = d.answers.filter((r) => r.key.startsWith("note_q_")).map((r) => ({ key: r.key, q: r.key.slice(5), number: r.number || "", prompt: r.prompt || r.label.replace(/^Note — /, ""), note: r.value }));
  return { answer, notes, asks: String(answer.get("_note_asks") || "").split(",").map((k) => k.trim()).filter(Boolean) };
}

/**
 * NPSA's notes on the client's Information Collection answers, as a short summary. Writing them
 * happens in NotesPane, which takes over the whole dialog so answers and notes have room.
 */
function NotesSection({ client, version, onOpen }: { client: ClientRow; version: number; onOpen: () => void }) {
  const [data, setData] = useState<NotesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadNotes(client.slug).then(setData).catch((e) => setErr((e as Error).message)); }, [client.slug, version]);
  const withNote = data ? data.notes.filter((n) => n.note || data.asks.includes(n.q)) : [];
  const open = data ? data.asks.length : 0;
  return (
    <Section title="NPSA notes" meta={data ? `${data.notes.filter((n) => n.note).length} on the form${open ? ` · ${open} question${open === 1 ? "" : "s"} for the client` : ""}` : undefined}>
      {err && <ErrorLine>{err}</ErrorLine>}
      {!data && !err && <Skeleton rows={2} />}
      {data && withNote.length === 0 && <Faint>No notes yet. The client sees a note under their answer.</Faint>}
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {withNote.map((n) => (
          <li key={n.key} style={{ display: "grid", gridTemplateColumns: "36px minmax(0, 1fr)", gap: 8, alignItems: "baseline", fontSize: 14 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--mute)" }}>{n.number}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--sec)" }}>
              {data!.asks.includes(n.q) && <span className="badge badge-dot badge-warn" style={{ marginRight: 8, verticalAlign: 1 }}>Question</span>}
              {n.note || <Faint>(no text)</Faint>}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 12 }}>
        <Button variant="secondary" size="sm" onClick={onOpen}>{withNote.length ? "Open notes" : "Write notes"}</Button>
      </div>
    </Section>
  );
}

/**
 * The notes editor: every Information Collection question with the client's full answer beside
 * the note, grouped by form section. "Ask the client" turns a note into a question, amber on
 * their form until cleared. Takes over the dialog body; Back returns to the client.
 */
function NotesPane({ client, onClose, closeGuard, confirm }: { client: ClientRow; onClose: (saved: boolean) => void; closeGuard: React.MutableRefObject<(() => Promise<boolean>) | null>; confirm: (o: ConfirmOptions) => Promise<boolean> }) {
  const stacked = useMedia("(max-width: 900px)");
  const [data, setData] = useState<NotesData | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [asks, setAsks] = useState<string[]>([]);
  const [only, setOnly] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const reset = (d: NotesData) => { setData(d); setDraft(Object.fromEntries(d.notes.map((n) => [n.key, n.note]))); setAsks(d.asks); };
  useEffect(() => { loadNotes(client.slug).then(reset).catch((e) => setErr((e as Error).message)); }, [client.slug]);
  const changed = data ? Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== (data.notes.find((n) => n.key === k)?.note || ""))) : {};
  const asksChanged = data ? asks.slice().sort().join(",") !== data.asks.slice().sort().join(",") : false;
  const dirty = Object.keys(changed).length > 0 || asksChanged;
  const leave = async () => { if (dirty && !(await confirm(discardPrompt("note", "Leave")))) return; onClose(savedOnce); };
  closeGuard.current = async () => !dirty || (await confirm(discardPrompt("note", "Close")));
  useEffect(() => () => { closeGuard.current = null; }, [closeGuard]);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await patchJson(`/api/clients/${client.slug}`, { ...(Object.keys(changed).length ? { question_notes: changed } : {}), ...(asksChanged ? { note_asks: asks } : {}) });
      reset(await loadNotes(client.slug)); setSavedOnce(true);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const groups = Object.keys(NOTE_SECTIONS).filter((sec) => only === "all" || only === "noted" || only === sec).map((sec) => ({
    sec,
    rows: (data?.notes || []).filter((n) => n.number.split(".")[0] === sec).filter((n) => only !== "noted" || draft[n.key] || asks.includes(n.q)),
  })).filter((g) => g.rows.length);
  const chip = (id: string, label: string) => (
    <button key={id} type="button" onClick={() => setOnly(id)} aria-pressed={only === id} className="chip">{label}</button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <PaneHeader
        title="NPSA notes"
        help="The client sees each note under their answer; questions show in amber until you clear them."
        onBack={leave} dirty={dirty} busy={busy} onSave={save} saveLabel="Save notes"
      />
      <div role="group" aria-label="Show" className="chips" style={{ display: "flex", padding: "10px 26px", borderBottom: "1px solid var(--hair2)" }}>
        {chip("all", "All")}
        {chip("noted", "With a note")}
        {Object.entries(NOTE_SECTIONS).map(([sec, name]) => chip(sec, `${sec} · ${name}`))}
      </div>
      <div style={{ overflowY: "auto", padding: "8px 26px 30px" }}>
        {err && <Note>{err}</Note>}
        {!data && !err && <Note>Loading…</Note>}
        {data && groups.length === 0 && <div style={{ padding: "18px 0" }}><Faint>No notes in this view yet.</Faint></div>}
        {groups.map((g) => (
          <section key={g.sec} style={{ marginTop: 20 }}>
            <Eyebrow style={{ marginBottom: 6 }}>Section {g.sec} · {NOTE_SECTIONS[g.sec]}</Eyebrow>
            {g.rows.map((n) => {
              const a = data!.answer.get(n.q) || "";
              const ask = asks.includes(n.q);
              return (
                <div key={n.key} style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", gap: stacked ? 10 : 28, padding: "16px 0", borderTop: "1px solid var(--hair)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "40px minmax(0, 1fr)", gap: 6, alignItems: "baseline" }}>
                      <span className="mono" style={{ fontSize: 12, color: "var(--mute)" }}>{n.number}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", lineHeight: "20px" }}>{n.prompt}</span>
                    </div>
                    <div style={{ marginTop: 8, marginLeft: 46, fontSize: 14, lineHeight: "22px", color: a ? "var(--sec)" : "var(--mute)", whiteSpace: "pre-line", maxHeight: 240, overflowY: "auto" }}>
                      {a || "No answer yet"}
                    </div>
                  </div>
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                    <textarea
                      value={draft[n.key] || ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [n.key]: e.target.value }))}
                      rows={Math.min(10, Math.max(3, Math.ceil((draft[n.key] || "").length / 70) + 1))}
                      placeholder="Note the client will see under their answer"
                      aria-label={`NPSA note on ${n.number}`}
                      className="field"
                      style={ask ? { borderColor: "var(--warn-fg)" } : undefined}
                    />
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: ask ? "var(--warn-fg)" : "var(--sec)", cursor: "pointer" }}>
                      <input type="checkbox" checked={ask} onChange={(e) => setAsks((l) => (e.target.checked ? [...l, n.q] : l.filter((k) => k !== n.q)))} style={{ accentColor: "var(--navy)" }} />
                      Ask the client (shows as a question on their form)
                    </label>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/* ── Client dialog ────────────────────────────────────────────── */

function ClientDialog({ row, onClose }: { row: ClientRow; onClose: () => void }) {
  const [detail, setDetail] = useState<{ client: ClientRow; status: Status } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stacked = useMedia("(max-width: 900px)");
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesVersion, setNotesVersion] = useState(0);
  const [ckOpen, setCkOpen] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [toast, notify] = useToast();
  // While a pane is open, closing the dialog asks first if an edit is unsaved.
  const notesGuard = useRef<(() => Promise<boolean>) | null>(null);
  const close = async () => { if (!notesGuard.current || (await notesGuard.current())) onClose(); };

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    Promise.all([getJson<ClientRow>(`/api/clients/${row.slug}`), getJson<Status>(`/api/clients/${row.slug}/status`)])
      .then(([client, status]) => { if (live) setDetail({ client, status }); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [row.slug]);

  // Escape closes; the page behind stays put while the dialog scrolls. A confirm on top takes Escape first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") void close(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyLink = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const saved = (fresh: ClientRow) => {
    setDetail((d) => (d ? { ...d, client: fresh } : d));
    // Applications change caps and documents, so the status read follows.
    getJson<Status>(`/api/clients/${row.slug}/status`).then((status) => setDetail((d) => (d ? { ...d, status } : d))).catch(() => {});
  };

  const c = detail?.client || row;
  const s = detail?.status;
  const picked = s?.wish_lists ? s.wish_lists.reduce((n, w) => n + w.prioritized, 0) : s?.wish_list ? s.wish_list.reduce((n, f) => n + f.prioritized, 0) : 0;
  // Each application's list, or the single list a client without applications has.
  const lists = s?.wish_lists
    ? s.wish_lists.map((w) => ({ key: w.application, label: w.label as string | null, status: w.status, facilities: w.facilities, budget: w.budget }))
    : s?.wish_list ? [{ key: "a1", label: null, status: "active" as AppStatus, facilities: s.wish_list, budget: s.budget }] : [];
  const quiet = daysSince(c.last_client_activity_at);

  const dt: React.CSSProperties = { color: "var(--mute)", fontSize: 13, lineHeight: "20px", whiteSpace: "nowrap" };
  const dd: React.CSSProperties = { margin: 0, minWidth: 0 };

  // Rendered on <body>: the page wrapper animates in with a transform, which
  // would otherwise turn this "fixed" overlay into one positioned inside it.
  return createPortal(
    <div onClick={() => void close()} role="presentation" className="scrim">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="dialog"
        style={{ maxWidth: 1080, maxHeight: "calc(100dvh - 64px)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {/* Header: who, where, the link, and the one switch that reveals editing */}
        <div style={{ padding: "20px 26px 16px", borderBottom: "1px solid var(--hair)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 id="client-dialog-title" className="headline" style={{ fontSize: 26, lineHeight: "32px", marginBottom: 8 }}>{c.name}</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--sec)", fontSize: 14 }}>
                <span><span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{c.state}</span> · {saaShort(c.saa)}</span>
                <PhaseChip phase={c.phase} />
                <StatusChip status={c.status} />
              </div>
              {(s?.applications?.length || 0) > 0 && <div style={{ marginTop: 10 }}><AppChips apps={s!.applications!} size="md" /></div>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Button variant={editing ? "primary" : "secondary"} size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Done editing" : "Edit"}
              </Button>
              <button ref={closeRef} type="button" aria-label="Close" onClick={() => void close()} className="btn btn-secondary btn-sm btn-icon">
                <X size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, background: "var(--bg)", border: "1px solid var(--hair)", borderRadius: 10, padding: "6px 6px 6px 12px", flexWrap: "wrap" }}>
            <span className="mono" style={{ flex: "1 1 240px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--sec)" }} title="The link carries the client's token. Send it only to them.">
              {c.intake_url.replace(/^https?:\/\//, "").replace(/\?t=.*/, "")}
            </span>
            <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={() => copyLink(c.intake_url)}>{copied ? "Copied" : "Copy link"}</Button>
            <a href={c.intake_url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
              Open form <ExternalLink size={15} strokeWidth={1.75} aria-hidden />
            </a>
          </div>
        </div>

        {ckOpen && detail && <ChecklistPane client={c} items={detail.status.checklist.items} closeGuard={notesGuard} confirm={confirm} onClose={(didSave) => { setCkOpen(false); if (didSave) getJson<Status>(`/api/clients/${row.slug}/status`).then((status) => setDetail((d) => (d ? { ...d, status } : d))).catch(() => {}); }} />}
        {notesOpen && detail && <NotesPane client={c} closeGuard={notesGuard} confirm={confirm} onClose={(saved) => { setNotesOpen(false); if (saved) setNotesVersion((v) => v + 1); }} />}

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "18px 26px 26px", display: notesOpen || ckOpen ? "none" : undefined }}>
          {error && <Note>Could not load this client: {error}</Note>}
          {!error && !s && <Note>Loading…</Note>}
          {s && (
            <>
              {/* The four numbers that answer "where do they stand" */}
              <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 8 }}>
                <Stat label="Intake" value={`${pct(s.core.answered, s.core.total)}%`} sub={`${s.core.answered} of ${s.core.total} core answers`} bar={pct(s.core.answered, s.core.total)} />
                <Stat label="Checklist" value={`${s.checklist.completed} of ${s.checklist.total}`} sub={s.checklist.not_applicable ? `${s.checklist.not_applicable} not applicable` : "Tasks completed"} bar={pct(s.checklist.completed, s.checklist.total)} />
                <Stat
                  label="Wish list"
                  value={picked ? `${picked} item${picked === 1 ? "" : "s"}` : "None yet"}
                  sub={s.budget && s.budget.requested > 0 ? `${usd(s.budget.requested)} of ${usd(s.budget.cap)} allowed` : "Nothing costed yet"}
                  bar={s.budget && s.budget.requested > 0 ? pct(s.budget.requested, s.budget.cap) : undefined}
                  tone={s.budget && s.budget.room < 0 ? "err" : undefined}
                />
                <Stat
                  label="Last save"
                  value={quiet === null ? "Never" : quiet === 0 ? "Today" : quiet === 1 ? "Yesterday" : `${quiet} days ago`}
                  sub={s.filled_by ? `By ${s.filled_by}` : "Nobody filling it in yet"}
                  tone={c.status === "active" && quiet !== null && quiet > 14 ? "warn" : undefined}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "minmax(0, 5fr) minmax(0, 6fr)", gap: stacked ? 0 : 36, alignItems: "start" }}>
                {/* Left: the engagement and the people and papers around it */}
                <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
                  <ApplicationsSection client={c} derived={s.applications_set ? [] : s.applications || []} editing={editing} onSaved={saved} />
                  <Section title="Engagement">
                    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px", fontSize: 14, lineHeight: "20px", margin: 0 }}>
                      <dt style={dt}>Track</dt><dd style={dd}>{c.program_track || <Faint>Not set</Faint>}</dd>
                      <dt style={dt}>Kickoff</dt><dd style={dd}>{c.kickoff_date ? `${fmtDate(c.kickoff_date, { month: "short", day: "numeric", year: "numeric" })} (Day 0)` : <span className="badge badge-dot badge-warn">Not booked</span>}</dd>
                      {c.submitted_at && (<><dt style={dt}>Submitted</dt><dd style={dd}>{s.status_line || fmtDate(c.submitted_at)}</dd></>)}
                      <dt style={dt}>SAA</dt>
                      <dd style={dd}>
                        {c.saa || <Faint>Unknown</Faint>}{" "}
                        <a href={`/grant-knowledge?state=${c.state}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 500, color: "var(--navy)", whiteSpace: "nowrap", textDecoration: "none" }}>
                          What {c.state} requires <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
                        </a>
                      </dd>
                      <dt style={dt}>Links</dt>
                      <dd style={dd}>
                        {c.asana_project_gid ? <Ext href={`https://app.asana.com/0/${c.asana_project_gid}/list`}>Asana</Ext> : <Faint>No Asana</Faint>}
                        {" "}<Faint>·</Faint>{" "}
                        {c.drive_folder_id ? <Ext href={`https://drive.google.com/drive/folders/${c.drive_folder_id}`}>Client folder</Ext> : <Faint>No client folder</Faint>}
                        {c.upload_folder_id && <> <Faint>·</Faint> <Ext href={`https://drive.google.com/drive/folders/${c.upload_folder_id}`}>Phase 2</Ext></>}
                      </dd>
                    </dl>
                  </Section>
                  <PeopleSection client={c} editing={editing} onSaved={saved} confirm={confirm} notify={notify} />
                  <DocumentsSection client={c} uploads={s.uploads} editing={editing} onSaved={saved} />
                  <NotesSection client={c} version={notesVersion} onOpen={() => setNotesOpen(true)} />
                </div>

                {/* Right: how far along */}
                <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
                  <Section title="Intake by section" meta={s.programs ? `${s.programs.listed} program${s.programs.listed === 1 ? "" : "s"} listed` : undefined}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {s.sections.filter((x) => CORE_SECTION.test(x.section) && !(s.programs && x.section === "Programs")).map((x) => (
                        <div key={x.section} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", fontSize: 14 }}>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: x.answered === x.total ? "var(--mute)" : "var(--ink)" }}>{x.section}</span>
                          <Progress a={x.answered} b={x.total} width={120} />
                        </div>
                      ))}
                    </div>
                  </Section>

                  {lists.length > 0 && (
                    <Section title="Wish list and budget" meta={s.budget && s.budget.requested > 0 ? `${usd(s.budget.requested)} of ${usd(s.budget.cap)}${s.wish_lists && s.wish_lists.length > 1 ? " now" : ""}` : undefined}>
                      {picked === 0 && <Faint>Nothing picked yet. An item counts once the client gives it a priority.</Faint>}
                      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        {lists.filter((l) => l.facilities.some((f) => f.prioritized > 0)).map((l) => (
                          <div key={l.key} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {l.label && (
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, paddingBottom: 6, borderBottom: "1px dashed var(--line-strong)" }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{l.label}{l.status !== "active" && <span style={{ color: "var(--warn-fg)", fontWeight: 500 }}> · {APP_STATUS_LABEL[l.status]}</span>}</span>
                                {l.budget && <span className="num" style={{ fontSize: 13, color: l.budget.room < 0 ? "var(--err-fg)" : "var(--mute)", whiteSpace: "nowrap" }}>{usd(l.budget.requested)} of {usd(l.budget.cap)}</span>}
                              </div>
                            )}
                            {l.facilities.filter((f) => f.prioritized > 0).map((f) => (
                              <div key={f.facility}>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14, marginBottom: 6 }}>
                                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    <span style={{ fontWeight: 600 }}>{f.name || `Facility ${f.facility}`}</span>
                                    <span style={{ color: "var(--mute)", fontSize: 13 }}> · {f.prioritized} item{f.prioritized === 1 ? "" : "s"}</span>
                                  </span>
                                  {f.budget && f.budget.total > 0 && (
                                    <span className="num" style={{ fontSize: 13, whiteSpace: "nowrap", color: f.budget.room < 0 ? "var(--err-fg)" : "var(--sec)" }}>
                                      {usd(f.budget.total)} of {usd(f.budget.cap)}{f.budget.room < 0 ? ` · ${usd(-f.budget.room)} over` : ""}
                                    </span>
                                  )}
                                </div>
                                {f.budget && f.budget.total > 0 && <div style={{ marginBottom: 8 }}><Bar pct={Math.min(100, pct(f.budget.total, f.budget.cap))} color={f.budget.room < 0 ? "var(--err-fg)" : "var(--olive)"} height={6} animate={false} /></div>}
                                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                                  {f.items.map((it) => (
                                    <li key={it.stem} style={{ display: "grid", gridTemplateColumns: "24px minmax(0, 1fr) auto", gap: 10, alignItems: "center", fontSize: 13 }}>
                                      <span className="num" title="Priority" style={{ fontSize: 12, fontWeight: 600, color: "var(--ok-fg)", background: "var(--ok-bg)", borderRadius: 6, textAlign: "center", lineHeight: "20px" }}>{it.priority}</span>
                                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--sec)" }}>{it.label}<span style={{ color: "var(--mute)" }}> · {it.answered} of {it.total} details</span></span>
                                      <span className="num" style={{ color: it.cost ? "var(--sec)" : "var(--mute)", textAlign: "right" }}>{it.cost ? usd(it.cost) : "No cost yet"}</span>
                                    </li>
                                  ))}
                                </ul>
                                {f.budget && f.budget.ma_on && f.budget.ma > 0 && <div className="meta" style={{ marginTop: 6 }}>M&amp;A {usd(f.budget.ma)}{f.budget.ma_default ? " (5%)" : ""}{f.budget.uncosted ? ` · ${f.budget.uncosted} item${f.budget.uncosted === 1 ? "" : "s"} without a cost` : ""}</div>}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  <ChecklistSection checklist={s.checklist} onEdit={() => setCkOpen(true)} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {confirmDialog}
      {toast}
    </div>,
    document.body
  );
}

/* ── The page ─────────────────────────────────────────────────── */

const VIEWS: { key: Exclude<View, "all">; label: string; note: string; warn?: boolean }[] = [
  { key: "active", label: "Active clients", note: "In grant writing" },
  { key: "kickoff", label: "Awaiting kickoff", note: "Registered, Day 0 not set" },
  { key: "quiet", label: "Quiet 14+ days", note: "No client save since then", warn: true },
  { key: "submitted", label: "Submitted", note: "Marked complete by the client" },
];
const VIEW_TITLE: Record<View, string> = { active: "Active clients", kickoff: "Awaiting kickoff", quiet: "Quiet for 14+ days", submitted: "Submitted", all: "All clients" };

const SORTS: { key: Sort; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "name", label: "Name" },
  { key: "save", label: "Last save, oldest first" },
  { key: "intake", label: "Intake, least done first" },
];

const inView = (r: ClientRow, v: View) => {
  if (v === "all") return true;
  if (v === "submitted") return r.status === "submitted";
  if (r.status !== "active") return false;
  if (v === "kickoff") return !r.kickoff_date;
  if (v === "quiet") { const d = daysSince(r.last_client_activity_at); return d !== null && d > 14; }
  return true;
};

/**
 * Who to look at first: stalled, then quiet, then kicked off but never saved,
 * then everyone else by how long since they saved. Clients not yet kicked off
 * and never saved come after, since silence is expected there.
 */
function attentionRank(r: ClientRow): [number, number] {
  if (r.status !== "active") return [5, 0];
  const d = daysSince(r.last_client_activity_at);
  if (d === null) return r.kickoff_date ? [2, 0] : [4, 0];
  if (d > 30) return [0, -d];
  if (d > 14) return [1, -d];
  return [3, -d];
}

export default function GrantWritingPage() {
  const [view, setView] = useState<View>("active");
  const [sort, setSort] = useState<Sort>("attention");
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ClientRow | null>(null);
  const narrow = useMedia("(max-width: 980px)");
  const phone = useMedia("(max-width: 760px)");
  const close = useCallback(() => setOpen(null), []);

  // One read of every client. The tiles and the views are filters over it, so
  // switching views is instant and the counts always agree with the list.
  useEffect(() => {
    let live = true;
    getJson<ClientRow[]>(`/api/clients?status=all`)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  const counts = useMemo(() => {
    const all = rows || [];
    return {
      active: all.filter((r) => inView(r, "active")).length,
      kickoff: all.filter((r) => inView(r, "kickoff")).length,
      quiet: all.filter((r) => inView(r, "quiet")).length,
      submitted: all.filter((r) => inView(r, "submitted")).length,
      all: all.length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (rows || [])
      .filter((r) => inView(r, view))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.state.toLowerCase() === q || (r.saa || "").toLowerCase().includes(q));
    const byName = (a: ClientRow, b: ClientRow) => a.name.localeCompare(b.name);
    const never = 1e9;
    const cmp: Record<Sort, (a: ClientRow, b: ClientRow) => number> = {
      attention: (a, b) => { const [a1, a2] = attentionRank(a); const [b1, b2] = attentionRank(b); return a1 - b1 || a2 - b2 || byName(a, b); },
      name: byName,
      save: (a, b) => (daysSince(b.last_client_activity_at) ?? never) - (daysSince(a.last_client_activity_at) ?? never) || byName(a, b),
      intake: (a, b) => pct(a.core.answered, a.core.total) - pct(b.core.answered, b.core.total) || byName(a, b),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, view, search, sort]);

  const showStage = view === "all";
  const showSubmitted = view === "submitted";

  return (
    <Page>
      <div style={{ marginBottom: 28 }}>
        <PageHeading description="In-house NSGP clients: what each one has answered, who is filling it in, and how long since they last saved.">
          Grant Writing
        </PageHeading>
      </div>

      {/* The tiles are the views: pick one to list just those clients. */}
      <div role="group" aria-label="Show clients" style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
        {VIEWS.map((v, i) => {
          const n = counts[v.key];
          const warn = !!v.warn && n > 0;
          return (
            <button key={v.key} type="button" className="view-tile" aria-pressed={view === v.key} onClick={() => setView(v.key)} style={{ animationDelay: `${i * 50}ms` }}>
              <span className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {warn && <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warn-fg)" }} />}
                {v.label}
              </span>
              <span className="kpi" style={{ fontSize: 34, lineHeight: "40px", color: warn ? "var(--warn-fg)" : "var(--ink)" }}>{rows ? n : "—"}</span>
              <span style={{ fontSize: 13, lineHeight: "18px", color: "var(--sec)" }}>{v.note}</span>
            </button>
          );
        })}
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 20px", borderBottom: "1px solid var(--hair)", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 className="section-title">{VIEW_TITLE[view]}</h2>
            {rows && <span className="meta">{visible.length} {visible.length === 1 ? "client" : "clients"}</span>}
            {rows && (view === "all"
              ? <button type="button" onClick={() => setView("active")} style={linkBtn}>Back to active clients</button>
              : <button type="button" onClick={() => setView("all")} style={linkBtn}>Show all {counts.all}</button>)}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: phone ? "1 1 100%" : undefined }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="meta">Sort</span>
              <select className="field field-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ width: "auto" }}>
                {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            <label style={{ position: "relative", display: "block", width: phone ? "100%" : 260, maxWidth: "100%" }}>
              <Search size={15} strokeWidth={1.75} aria-hidden style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--mute)", pointerEvents: "none" }} />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search clients, states or SAAs"
                aria-label="Search clients"
                className="field field-sm"
                style={{ paddingLeft: 32 }}
              />
            </label>
          </div>
        </div>

        {error && <Note>Could not load clients: {error}</Note>}
        {!error && rows === null && <div style={{ padding: "8px 20px" }}><Skeleton rows={6} /></div>}
        {!error && rows !== null && visible.length === 0 && <Note>{search ? "No clients match that search." : "No clients in this view."}</Note>}

        {/* Phones: one card per client instead of a table that scrolls sideways. */}
        {!error && visible.length > 0 && phone && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {visible.map((r) => (
              <li key={r.slug}>
                <button type="button" className="client-card" onClick={() => setOpen(r)}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 15, lineHeight: "21px", fontWeight: 600, color: "var(--ink)" }}>{r.name}</span>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden style={{ color: "var(--mute)", flexShrink: 0, marginTop: 2 }} />
                  </span>
                  <span className="meta"><span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{r.state}</span> · {saaShort(r.saa)}</span>
                  {r.applications && r.applications.length > 0 && <AppChips apps={r.applications} />}
                  <span style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: "6px 10px", alignItems: "center" }}>
                    <span className="meta">Intake</span><Progress a={r.core.answered} b={r.core.total} width={110} />
                    <span className="meta">Checklist</span><Progress a={r.checklist.completed} b={r.checklist.total} width={110} />
                  </span>
                  {showSubmitted
                    ? <span className="meta">Submitted {fmtDate(r.submitted_at, { month: "short", day: "numeric", year: "numeric" })}</span>
                    : <LastSave row={r} inline />}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!error && visible.length > 0 && !phone && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ width: "36%" }}>Client</th>
                  <th>State · SAA</th>
                  {showStage && <th>Stage</th>}
                  <th>Intake</th>
                  <th>Checklist</th>
                  <th>{showSubmitted ? "Submitted" : "Last save"}</th>
                  <th style={{ width: 40 }} aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.slug}
                    onClick={() => setOpen(r)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(r); } }}
                    style={{ cursor: "pointer" }}
                    className="row-hover"
                  >
                    <td>
                      <div style={{ fontWeight: 500, color: "var(--ink)", lineHeight: "20px" }}>{r.name}</div>
                      <div style={{ marginTop: 6 }}>
                        {r.applications && r.applications.length > 0
                          ? <AppChips apps={r.applications} />
                          : <span className="meta">No application set yet</span>}
                      </div>
                    </td>
                    <td style={{ maxWidth: 170 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                        <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{r.state}</span>
                        <span title={r.saa || undefined} style={{ color: "var(--mute)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{saaShort(r.saa)}</span>
                      </div>
                    </td>
                    {showStage && (
                      <td style={{ whiteSpace: "nowrap" }}>
                        <StatusChip status={r.status} />
                        <div className="meta" style={{ marginTop: 4 }}>{r.phase} · {PHASE[r.phase] || "Unknown"}</div>
                      </td>
                    )}
                    <td style={{ whiteSpace: "nowrap" }}><Progress a={r.core.answered} b={r.core.total} /></td>
                    <td style={{ whiteSpace: "nowrap" }}><Progress a={r.checklist.completed} b={r.checklist.total} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {showSubmitted
                        ? <span className="num" style={{ color: "var(--sec)" }}>{fmtDate(r.submitted_at, { month: "short", day: "numeric", year: "numeric" }) || "—"}</span>
                        : <LastSave row={r} />}
                    </td>
                    <td style={{ color: "var(--mute)", paddingLeft: 0, verticalAlign: "middle" }}>
                      <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <ClientDialog row={open} onClose={close} />}
    </Page>
  );
}
