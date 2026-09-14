"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Page,
  Card,
  PageHeading,
  Eyebrow,
  StatTile,
  SegPill,
  Bar,
  Note,
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
};

type Doc = { key: string; label: string; hint?: string; source?: "standard" | "state" | "custom" };

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
  core: { answered: number; total: number };
  checklist: { completed: number; total: number };
  filled_by: string;
};

type ChecklistItem = { stem: string; label: string; status: string; due: string; owner: string; note: string };
type Upload = { id: number; key: string; label: string; filename: string; size_bytes: number; uploaded_at: string; drive_url: string | null };

/** Fetches a client upload with the login token and hands it to the browser as a download. */
async function downloadUpload(slug: string, u: Upload) {
  const r = await fetch(`/api/clients/${slug}/uploads/${u.id}`, { headers: authHeaders() });
  if (!r.ok) { alert(`Could not download ${u.filename} (HTTP ${r.status})`); return; }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url; a.download = u.filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  /** Program rows with a name, out of the slots the page offers. */
  programs?: { listed: number; slots: number };
  /** What the client has asked for across sites, against the federal applicant cap. */
  budget?: { requested: number; cap: number; room: number; sites: number };
  checklist: { completed: number; total: number; not_applicable?: number; items: ChecklistItem[] };
  uploads: Upload[];
};

type Filter = "active" | "submitted" | "all";

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

function Pill({ children, fg, bg }: { children: React.ReactNode; fg: string; bg: string }) {
  return (
    <span
      className="mono"
      style={{
        fontWeight: 600,
        fontSize: 10.5,
        letterSpacing: ".06em",
        padding: "3px 10px",
        borderRadius: 999,
        color: fg,
        background: bg,
        whiteSpace: "nowrap",
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
}

function StatusChip({ status }: { status: ClientRow["status"] }) {
  const map: Record<ClientRow["status"], [string, string]> = {
    active: ["var(--run-fg)", "var(--run-bg)"],
    submitted: ["var(--ok-fg)", "var(--ok-bg)"],
    cancelled: ["var(--err-fg)", "var(--err-bg)"],
    closed: ["var(--q-fg)", "var(--q-bg)"],
  };
  const [fg, bg] = map[status] || map.closed;
  return <Pill fg={fg} bg={bg}>{status}</Pill>;
}

function PhaseChip({ phase }: { phase: number }) {
  return <Pill fg="var(--sec)" bg="var(--q-bg)">{phase} · {PHASE[phase] || "?"}</Pill>;
}

function Quiet({ row }: { row: ClientRow }) {
  const d = daysSince(row.last_client_activity_at);
  if (d === null) return <span style={{ color: "var(--faint)", fontSize: 12.5 }}>never</span>;
  const color = row.status !== "active" ? "var(--mute)" : d > 30 ? "var(--err-fg)" : d > 14 ? "var(--warn-fg)" : "var(--ok-fg)";
  return (
    <span className="mono" style={{ color, fontWeight: 600, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
      {d === 0 ? "today" : `${d}d ago`}
    </span>
  );
}

function Progress({ a, b, width = 88 }: { a: number; b: number; width?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width, display: "inline-block" }}>
        <Bar pct={pct(a, b)} color="var(--olive)" height={6} radius={3} animate={false} />
      </span>
      <span className="mono" style={{ fontSize: 12, color: "var(--sec)", fontVariantNumeric: "tabular-nums", minWidth: 44 }}>
        {a}/{b}
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

const Faint = ({ children }: { children: React.ReactNode }) => <span style={{ color: "var(--faint)" }}>{children}</span>;

const inputStyle: React.CSSProperties = { fontSize: 12.5, padding: "6px 9px", borderRadius: 8, border: "1px solid var(--bd2)", background: "var(--bg)", color: "var(--ink)", minWidth: 0, width: "100%" };
const smallBtn: React.CSSProperties = { fontSize: 11.5, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--bd2)", background: "var(--card)", color: "var(--ink)", cursor: "pointer", whiteSpace: "nowrap" };
const xBtn: React.CSSProperties = { border: 0, background: "transparent", color: "var(--faint)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px" };

/* ── Team edits inside the dialog ─────────────────────────────── */

/** One titled block in the dialog: a quiet eyebrow, an optional right-hand summary, then the content. */
function Section({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ paddingTop: 18, borderTop: "1px solid var(--hair2)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <Eyebrow style={{ fontSize: 11 }}>{title}</Eyebrow>
        {meta && <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>{meta}</span>}
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
      <Eyebrow style={{ fontSize: 10.5, marginBottom: 6 }}>{label}</Eyebrow>
      <div className="headline" style={{ fontSize: 20, lineHeight: 1.1, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {bar !== undefined && <div style={{ marginTop: 8 }}><Bar pct={Math.min(100, bar)} color={tone === "err" ? "var(--err-fg)" : "var(--olive)"} height={5} radius={3} animate={false} /></div>}
      {sub && <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

/** The Documents-tab rows with what has come in against each; editing adds remove, add and reset. */
function DocumentsSection({ client, uploads, editing, onSaved }: { client: ClientRow; uploads: Upload[]; editing: boolean; onSaved: (c: ClientRow) => void }) {
  const [label, setLabel] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const docs = client.documents || [];
  const byKey = new Map<string, Upload[]>();
  for (const u of uploads) byKey.set(u.key, [...(byKey.get(u.key) || []), u]);
  const orphans = uploads.filter((u) => !docs.some((d) => d.key === u.key));
  const received = docs.filter((d) => byKey.has(d.key)).length;
  const run = async (body: unknown) => {
    setBusy(true); setErr(null);
    try { onSaved(await patchJson<ClientRow>(`/api/clients/${client.slug}`, body)); setLabel(""); setHint(""); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const fileRow = (u: Upload) => (
    <div key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>{u.filename}</span>
      <span className="mono" style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}>{fmtDate(u.uploaded_at)}</span>
      {u.drive_url && <Ext href={u.drive_url}>Drive</Ext>}
      <button type="button" onClick={() => downloadUpload(client.slug, u)} style={smallBtn}>Download</button>
    </div>
  );
  return (
    <Section title="documents" meta={`${received} of ${docs.length} received${client.documents_customised ? " · customised" : ""}`}>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        {docs.map((d) => {
          const files = byKey.get(d.key) || [];
          return (
            <li key={d.key} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
              <span aria-hidden style={{ marginTop: 5, width: 10, height: 10, borderRadius: "50%", justifySelf: "center", border: `2px solid ${files.length ? "var(--ok-fg)" : "var(--bd2)"}`, background: files.length ? "var(--ok-fg)" : "transparent" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: files.length ? "var(--mute)" : "var(--ink)" }}>{d.label}</div>
                {files.length === 0 && <div style={{ fontSize: 11.5, color: "var(--faint)" }}>not received yet{d.hint ? ` · ${d.hint}` : ""}</div>}
                {files.map(fileRow)}
              </div>
              {editing ? <button type="button" aria-label={`Remove ${d.label}`} title="Take this off the client's Documents tab" disabled={busy} onClick={() => run({ remove_document_keys: [d.key] })} style={xBtn}>×</button> : <span />}
            </li>
          );
        })}
        {orphans.length > 0 && (
          <li style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr)", gap: 10 }}>
            <span />
            <div><div style={{ color: "var(--mute)", fontSize: 12.5 }}>Also uploaded, no longer asked for</div>{orphans.map(fileRow)}</div>
          </li>
        )}
      </ul>
      {editing && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto", gap: 6, marginTop: 10 }}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a document, e.g. Board roster" aria-label="Document label" style={inputStyle} />
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Hint (PDF, where to get it)" aria-label="Document hint" style={inputStyle} />
            <button type="button" disabled={busy || !label.trim()} onClick={() => run({ add_documents: [{ key: docKeyFor(label), label: label.trim(), hint: hint.trim() }] })} style={smallBtn}>Add</button>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6, fontSize: 11.5, color: "var(--faint)" }}>
            <span>These rows are the client&rsquo;s Documents tab. Files already uploaded stay either way.</span>
            {client.documents_customised && <button type="button" disabled={busy} onClick={() => run({ documents: null })} style={{ ...xBtn, fontSize: 11.5, textDecoration: "underline" }}>Reset to defaults</button>}
          </div>
        </>
      )}
      {err && <div style={{ color: "var(--err-fg)", fontSize: 12, marginTop: 4 }}>{err}</div>}
    </Section>
  );
}

/** Everyone around the application: the client's people, NPSA, and the helpful outside contacts (editable). */
function PeopleSection({ client, editing, onSaved }: { client: ClientRow; editing: boolean; onSaved: (c: ClientRow) => void }) {
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
  const person = (x: Contact, removable = false) => (
    <div key={x.email} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 10, alignItems: "baseline", fontSize: 13 }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>{x.name || x.email}</span>
        {x.role && <span style={{ color: "var(--mute)" }}> · {x.role}</span>}
        {x.phone && <span className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}> · {x.phone}</span>}
      </span>
      <a href={`mailto:${x.email}`} className="mono" style={{ fontSize: 11.5, color: "var(--navy)", textDecoration: "none", whiteSpace: "nowrap" }}>{x.email}</a>
      {removable ? <button type="button" aria-label={`Remove ${x.name || x.email}`} disabled={busy} onClick={() => run({ remove_contact_emails: [x.email] })} style={xBtn}>×</button> : <span />}
    </div>
  );
  const sub = (t: string) => <div style={{ fontSize: 11, color: "var(--faint)", letterSpacing: ".06em", textTransform: "uppercase", marginTop: 12, marginBottom: 6 }} className="mono">{t}</div>;
  return (
    <Section title="people" meta={`${own.length} at the client`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {own.length === 0 && <Faint>No client contacts on file yet.</Faint>}
        {own.map((x) => person(x))}
      </div>
      {sub("NPSA")}
      <div style={{ fontSize: 13, color: "var(--sec)" }}>{npsa.map((x) => `${x.name.split(" ")[0]}${/consultant|sales rep/i.test(x.role) ? " (consultant)" : ""}`).join(", ") || <Faint>none</Faint>}</div>
      {(refs.length > 0 || editing) && sub("Helpful contacts · SAA, CISA")}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {refs.length === 0 && editing && <Faint>None yet. These show read-only on the client&rsquo;s Contacts tab.</Faint>}
        {refs.map((x) => person(x, editing))}
      </div>
      {editing && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
          <input value={f.name} onChange={set("name")} placeholder="Name" aria-label="Name" style={inputStyle} />
          <input value={f.role} onChange={set("role")} placeholder="Role, e.g. Texas SAA help desk" aria-label="Role" style={inputStyle} />
          <input value={f.email} onChange={set("email")} placeholder="Email" aria-label="Email" style={inputStyle} />
          <div style={{ display: "flex", gap: 6 }}>
            <input value={f.phone} onChange={set("phone")} placeholder="Phone" aria-label="Phone" style={inputStyle} />
            <button type="button" disabled={busy || !f.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)} onClick={() => run({ add_reference_contacts: [{ name: f.name.trim(), role: f.role.trim(), email: f.email.trim(), phone: f.phone.trim() }] })} style={smallBtn}>Add</button>
          </div>
        </div>
      )}
      {err && <div style={{ color: "var(--err-fg)", fontSize: 12, marginTop: 4 }}>{err}</div>}
    </Section>
  );
}

/** The 24 tasks, open ones first; finished and not-applicable ones fold away behind a count. */
function ChecklistSection({ checklist }: { checklist: Status["checklist"] }) {
  const [showDone, setShowDone] = useState(false);
  const open = checklist.items.filter((it) => it.status !== "Completed" && it.status !== "Not applicable");
  const rest = checklist.items.filter((it) => it.status === "Completed" || it.status === "Not applicable");
  const row = (it: ChecklistItem, i: number) => {
    const done = it.status === "Completed";
    const prog = it.status === "In progress";
    const na = it.status === "Not applicable";
    const meta = na ? "n/a" : done ? "done" : [prog ? "in progress" : "", it.due ? fmtDue(it.due) : "", it.owner].filter(Boolean).join(" · ");
    return (
      <li key={it.stem} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "6px 0", borderTop: i ? "1px solid var(--hair2)" : undefined, fontSize: 13 }}>
        <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", justifySelf: "center", border: `2px solid ${done ? "var(--ok-fg)" : prog ? "var(--warn-fg)" : "var(--bd2)"}`, background: done ? "var(--ok-fg)" : prog ? "var(--warn-bg)" : na ? "var(--bd2)" : "transparent", opacity: na ? 0.5 : 1 }} />
        <span style={{ minWidth: 0, color: done || na ? "var(--mute)" : "var(--ink)", lineHeight: 1.35, textDecoration: na ? "line-through" : undefined, opacity: na ? 0.6 : 1 }}>{it.label}</span>
        <span className="mono" style={{ fontSize: 11.5, color: prog ? "var(--warn-fg)" : "var(--faint)", whiteSpace: "nowrap", textAlign: "right" }}>{meta}</span>
      </li>
    );
  };
  return (
    <Section
      title={`checklist · ${open.length} left`}
      meta={rest.length > 0 ? (
        <button type="button" onClick={() => setShowDone((v) => !v)} style={{ ...xBtn, fontSize: 11.5, padding: 0, textDecoration: "underline", color: "var(--faint)" }}>
          {showDone ? "hide" : "show"} {checklist.completed} done{checklist.not_applicable ? ` · ${checklist.not_applicable} n/a` : ""}
        </button>
      ) : "nothing finished yet"}
    >
      {open.length === 0 && <Faint>Every task is finished or marked not applicable.</Faint>}
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{open.map(row)}</ul>
      {showDone && rest.length > 0 && (
        <ul style={{ margin: "10px 0 0", padding: "8px 0 0", listStyle: "none", opacity: 0.8, borderTop: "1px dashed var(--bd2)" }}>{rest.map(row)}</ul>
      )}
    </Section>
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

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    Promise.all([getJson<ClientRow>(`/api/clients/${row.slug}`), getJson<Status>(`/api/clients/${row.slug}/status`)])
      .then(([client, status]) => { if (live) setDetail({ client, status }); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [row.slug]);

  // Escape closes; the page behind stays put while the dialog scrolls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const copyLink = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const saved = (fresh: ClientRow) => setDetail((d) => (d ? { ...d, client: fresh } : d));

  const c = detail?.client || row;
  const s = detail?.status;
  const picked = s?.wish_list ? s.wish_list.reduce((n, f) => n + f.prioritized, 0) : 0;
  const quiet = daysSince(c.last_client_activity_at);

  const dt: React.CSSProperties = { color: "var(--faint)", fontSize: 11.5, paddingTop: 2, whiteSpace: "nowrap" };
  const dd: React.CSSProperties = { margin: 0, minWidth: 0 };

  // Rendered on <body>: the page wrapper animates in with a transform, which
  // would otherwise turn this "fixed" overlay into one positioned inside it.
  return createPortal(
    <div
      onClick={onClose}
      role="presentation"
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(12,16,24,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: stacked ? 12 : 32 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="card-surface"
        style={{ width: "100%", maxWidth: 1080, maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column", background: "var(--card)", border: "1px solid var(--bd2)", borderRadius: 18, boxShadow: "var(--shadow-card-hover)", overflow: "hidden" }}
      >
        {/* Header: who, where, the link, and the one switch that reveals editing */}
        <div style={{ padding: "20px 26px 16px", borderBottom: "1px solid var(--hair)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div id="client-dialog-title" className="headline" style={{ fontSize: 26, lineHeight: 1.15, marginBottom: 6, textWrap: "balance" } as React.CSSProperties}>{c.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", color: "var(--mute)", fontSize: 13 }}>
                <span>{c.state} · {saaShort(c.saa)}</span>
                <PhaseChip phase={c.phase} />
                <StatusChip status={c.status} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button type="button" onClick={() => setEditing((v) => !v)} style={{ ...smallBtn, background: editing ? "var(--navy)" : "var(--card)", color: editing ? "var(--on-accent)" : "var(--ink)", borderColor: editing ? "var(--navy)" : "var(--bd2)" }}>
                {editing ? "Done editing" : "Edit documents & contacts"}
              </button>
              <button
                ref={closeRef} type="button" aria-label="Close" onClick={onClose}
                style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "1px solid var(--bd2)", borderRadius: 9, color: "var(--sec)", cursor: "pointer", lineHeight: 1, padding: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.color = "var(--ink)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--sec)"; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, background: "var(--bg)", border: "1px solid var(--hair)", borderRadius: 10, padding: "6px 6px 6px 12px" }}>
            <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--sec)" }} title="The link carries the client's token. Send it only to them.">
              {c.intake_url.replace(/^https?:\/\//, "").replace(/\?t=.*/, "")}
            </span>
            <button type="button" onClick={() => copyLink(c.intake_url)} style={smallBtn}>{copied ? "Copied" : "Copy link"}</button>
            <a href={c.intake_url} target="_blank" rel="noreferrer" className="mono" style={{ ...smallBtn, background: "var(--navy)", color: "var(--on-accent)", borderColor: "var(--navy)", textDecoration: "none" }}>Open form</a>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "18px 26px 26px" }}>
          {error && <Note>Could not load {row.slug}: {error}</Note>}
          {!error && !s && <Note>Loading…</Note>}
          {s && (
            <>
              {/* The four numbers that answer "where do they stand" */}
              <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 8 }}>
                <Stat label="intake" value={`${pct(s.core.answered, s.core.total)}%`} sub={`${s.core.answered} of ${s.core.total} core answers`} bar={pct(s.core.answered, s.core.total)} />
                <Stat label="checklist" value={`${s.checklist.completed} / ${s.checklist.total}`} sub={s.checklist.not_applicable ? `${s.checklist.not_applicable} not applicable` : "tasks completed"} bar={pct(s.checklist.completed, s.checklist.total)} />
                <Stat
                  label="wish list"
                  value={picked ? `${picked} item${picked === 1 ? "" : "s"}` : "none yet"}
                  sub={s.budget && s.budget.requested > 0 ? `${usd(s.budget.requested)} of ${usd(s.budget.cap)} allowed` : "nothing costed yet"}
                  bar={s.budget && s.budget.requested > 0 ? pct(s.budget.requested, s.budget.cap) : undefined}
                  tone={s.budget && s.budget.room < 0 ? "err" : undefined}
                />
                <Stat
                  label="last save"
                  value={quiet === null ? "never" : quiet === 0 ? "today" : `${quiet}d ago`}
                  sub={s.filled_by ? `by ${s.filled_by}` : "nobody filling it in yet"}
                  tone={c.status === "active" && quiet !== null && quiet > 14 ? "warn" : undefined}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "minmax(0, 5fr) minmax(0, 6fr)", gap: stacked ? 0 : 36, alignItems: "start" }}>
                {/* Left: the engagement and the people and papers around it */}
                <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
                  <Section title="engagement">
                    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "7px 16px", fontSize: 13.5, margin: 0 }}>
                      <dt className="mono" style={dt}>Track</dt><dd style={dd}>{c.program_track || <Faint>not set</Faint>}</dd>
                      <dt className="mono" style={dt}>Kickoff</dt><dd style={dd}>{c.kickoff_date ? `${fmtDate(c.kickoff_date, { month: "short", day: "numeric", year: "numeric" })} (Day 0)` : <span style={{ color: "var(--warn-fg)" }}>not booked</span>}</dd>
                      {c.submitted_at && (<><dt className="mono" style={dt}>Submitted</dt><dd style={dd}>{s.status_line || fmtDate(c.submitted_at)}</dd></>)}
                      <dt className="mono" style={dt}>SAA</dt><dd style={dd}>{c.saa || <Faint>unknown</Faint>}</dd>
                      <dt className="mono" style={dt}>Links</dt>
                      <dd style={dd}>
                        {c.asana_project_gid ? <Ext href={`https://app.asana.com/0/${c.asana_project_gid}/list`}>Asana</Ext> : <Faint>no Asana</Faint>}
                        {" "}<Faint>·</Faint>{" "}
                        {c.drive_folder_id ? <Ext href={`https://drive.google.com/drive/folders/${c.drive_folder_id}`}>Client folder</Ext> : <Faint>no client folder</Faint>}
                        {c.upload_folder_id && <> <Faint>·</Faint> <Ext href={`https://drive.google.com/drive/folders/${c.upload_folder_id}`}>Phase 2</Ext></>}
                      </dd>
                    </dl>
                  </Section>
                  <PeopleSection client={c} editing={editing} onSaved={saved} />
                  <DocumentsSection client={c} uploads={s.uploads} editing={editing} onSaved={saved} />
                </div>

                {/* Right: how far along */}
                <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
                  <Section title="intake by section" meta={s.programs ? `${s.programs.listed} program${s.programs.listed === 1 ? "" : "s"} listed` : undefined}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {s.sections.filter((x) => CORE_SECTION.test(x.section) && !(s.programs && x.section === "Programs")).map((x) => (
                        <div key={x.section} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", fontSize: 13 }}>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: x.answered === x.total ? "var(--mute)" : "var(--ink)" }}>{x.section}</span>
                          <Progress a={x.answered} b={x.total} width={120} />
                        </div>
                      ))}
                    </div>
                  </Section>

                  {s.wish_list && (
                    <Section title="wish list & budget" meta={s.budget && s.budget.requested > 0 ? `${usd(s.budget.requested)} of ${usd(s.budget.cap)}` : undefined}>
                      {picked === 0 && <Faint>Nothing picked yet. An item counts once the client gives it a priority.</Faint>}
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        {s.wish_list.filter((f) => f.prioritized > 0).map((f) => (
                          <div key={f.facility}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, marginBottom: 6 }}>
                              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                <span style={{ fontWeight: 600 }}>{f.name || `Facility ${f.facility}`}</span>
                                <span className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}> · {f.prioritized} item{f.prioritized === 1 ? "" : "s"}</span>
                              </span>
                              {f.budget && f.budget.total > 0 && (
                                <span className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap", color: f.budget.room < 0 ? "var(--err-fg)" : "var(--sec)" }}>
                                  {usd(f.budget.total)} of {usd(f.budget.cap)}{f.budget.room < 0 ? ` · ${usd(-f.budget.room)} over` : ""}
                                </span>
                              )}
                            </div>
                            {f.budget && f.budget.total > 0 && <div style={{ marginBottom: 6 }}><Bar pct={Math.min(100, pct(f.budget.total, f.budget.cap))} color={f.budget.room < 0 ? "var(--err-fg)" : "var(--olive)"} height={6} radius={3} animate={false} /></div>}
                            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                              {f.items.map((it) => (
                                <li key={it.stem} style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) auto", gap: 10, alignItems: "center", fontSize: 12.5 }}>
                                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ok-fg)", background: "var(--ok-bg)", borderRadius: 6, textAlign: "center", padding: "1px 0" }}>{it.priority}</span>
                                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--sec)" }}>{it.label}<span style={{ color: "var(--faint)" }}> · {it.answered}/{it.total} details</span></span>
                                  <span className="mono" style={{ fontSize: 11.5, color: it.cost ? "var(--sec)" : "var(--faint)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{it.cost ? usd(it.cost) : "no cost"}</span>
                                </li>
                              ))}
                            </ul>
                            {f.budget && f.budget.ma_on && f.budget.ma > 0 && <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 4 }}>M&A {usd(f.budget.ma)}{f.budget.ma_default ? " (5%)" : ""}{f.budget.uncosted ? ` · ${f.budget.uncosted} item${f.budget.uncosted === 1 ? "" : "s"} without a cost` : ""}</div>}
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  <ChecklistSection checklist={s.checklist} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ── The page ─────────────────────────────────────────────────── */

export default function GrantWritingPage() {
  const [filter, setFilter] = useState<Filter>("active");
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ClientRow | null>(null);
  const narrow = useMedia("(max-width: 980px)");
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    getJson<ClientRow[]>(`/api/clients?status=${filter}`)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [filter]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (rows || []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.state.toLowerCase() === q);
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, search]);

  // Tiles come from the full list regardless of the filter, so they read the same on every view.
  const [all, setAll] = useState<ClientRow[] | null>(null);
  useEffect(() => {
    getJson<ClientRow[]>(`/api/clients?status=all`).then(setAll).catch(() => setAll([]));
  }, [rows]);
  const active = (all || []).filter((r) => r.status === "active");
  const tiles = {
    active: active.length,
    awaiting: active.filter((r) => !r.kickoff_date).length,
    quiet: active.filter((r) => { const d = daysSince(r.last_client_activity_at); return d !== null && d > 14; }).length,
    submitted: (all || []).filter((r) => r.status === "submitted").length,
  };

  const th: React.CSSProperties = {
    textAlign: "left", fontWeight: 600, fontSize: 10.5, letterSpacing: ".08em", color: "var(--faint)",
    padding: "10px 16px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid var(--hair)", verticalAlign: "middle" };

  return (
    <Page>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 26 }}>
        <PageHeading eyebrow={`grant writing · in-house clients · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toLowerCase()}`}>
          Every client, <em>where they stand.</em>
        </PageHeading>
        <div style={{ fontSize: 13, color: "var(--mute)", maxWidth: 420, lineHeight: 1.5 }}>
          What each client has answered, who is filling it in, and how long since they last touched it.
          Registering and seeding happen through Claude; this page reads.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
        <StatTile label="active clients" value={all ? String(tiles.active) : "…"} note="in grant writing" />
        <StatTile label="awaiting kickoff" value={all ? String(tiles.awaiting) : "…"} note="registered, Day 0 not set" delay={60} />
        <StatTile label="quiet over 14 days" value={all ? String(tiles.quiet) : "…"} note="no client save since then" accent={tiles.quiet > 0} delay={120} />
        <StatTile label="submitted" value={all ? String(tiles.submitted) : "…"} note="marked complete by the client" delay={180} />
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--hair)", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="headline" style={{ fontSize: 20 }}>Clients</span>
            <SegPill<Filter>
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[{ key: "active", label: "Active" }, { key: "submitted", label: "Submitted" }, { key: "all", label: "All" }]}
            />
            {rows && <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{visible.length} of {rows.length}</span>}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, slug or state"
            aria-label="Search clients"
            className="mono"
            style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 999, border: "1px solid var(--bd2)", background: "var(--bg)", color: "var(--ink)", minWidth: 220 }}
          />
        </div>

        {error && <Note>Could not load clients: {error}</Note>}
        {!error && rows === null && <Note>Loading…</Note>}
        {!error && rows !== null && visible.length === 0 && <Note>No clients match.</Note>}
        {!error && visible.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5, minWidth: 860 }}>
              <thead>
                <tr>
                  <th className="mono" style={{ ...th, width: "34%" }}>client</th>
                  <th className="mono" style={{ ...th, width: 150 }}>state · saa</th>
                  <th className="mono" style={th}>phase</th>
                  <th className="mono" style={th}>status</th>
                  <th className="mono" style={th}>intake</th>
                  <th className="mono" style={th}>checklist</th>
                  <th className="mono" style={th}>last save</th>
                  <th style={{ ...th, width: 28 }} aria-label="Open" />
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
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                  >
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: "var(--ink)", lineHeight: 1.3 }}>{r.name}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>{r.slug}</div>
                    </td>
                    <td style={{ ...td, maxWidth: 150 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                        <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{r.state}</span>
                        <span title={r.saa || undefined} style={{ color: "var(--mute)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{saaShort(r.saa)}</span>
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><PhaseChip phase={r.phase} /></td>
                    <td style={td}><StatusChip status={r.status} /></td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><Progress a={r.core.answered} b={r.core.total} /></td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><Progress a={r.checklist.completed} b={r.checklist.total} /></td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}><Quiet row={r} /></td>
                    <td style={{ ...td, color: "var(--faint)", paddingLeft: 0 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m9 6 6 6-6 6" />
                      </svg>
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
