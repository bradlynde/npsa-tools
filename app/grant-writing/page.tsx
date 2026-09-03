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
  side?: "npsa" | "client";
  is_primary?: boolean;
};

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
  core: { answered: number; total: number };
  checklist: { completed: number; total: number };
  filled_by: string;
};

type ChecklistItem = { stem: string; label: string; status: string; due: string; owner: string; note: string };
type Upload = { id: number; key: string; label: string; filename: string; size_bytes: number; uploaded_at: string; drive_url: string | null };
type Status = {
  slug: string;
  filled_by: string;
  status_line: string;
  core: { answered: number; total: number };
  sections: { section: string; answered: number; total: number }[];
  checklist: { completed: number; total: number; items: ChecklistItem[] };
  uploads: Upload[];
};

type Filter = "active" | "submitted" | "all";

const PHASE: Record<number, string> = { 1: "Sales", 2: "Grant writing", 3: "Compliance", 4: "Implementation" };

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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

function Label({ children }: { children: React.ReactNode }) {
  return <Eyebrow style={{ marginBottom: 10, fontSize: 11 }}>{children}</Eyebrow>;
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--navy)", textDecoration: "none", fontWeight: 500 }}>
      {children}
    </a>
  );
}

const Faint = ({ children }: { children: React.ReactNode }) => <span style={{ color: "var(--faint)" }}>{children}</span>;

/* ── Client dialog ────────────────────────────────────────────── */

function ClientDialog({ row, onClose }: { row: ClientRow; onClose: () => void }) {
  const [detail, setDetail] = useState<{ client: ClientRow; status: Status } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const c = detail?.client || row;
  const s = detail?.status;
  const npsa = (c.contacts || []).filter((x) => x.side === "npsa");
  const own = (c.contacts || []).filter((x) => x.side !== "npsa");

  const dt: React.CSSProperties = { color: "var(--faint)", fontSize: 11.5, paddingTop: 2, whiteSpace: "nowrap" };
  const dd: React.CSSProperties = { margin: 0, minWidth: 0 };

  // Rendered on <body>: the page wrapper animates in with a transform, which
  // would otherwise turn this "fixed" overlay into one positioned inside it.
  return createPortal(
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 80, background: "rgba(12,16,24,.55)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: stacked ? 12 : 32,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="card-surface"
        style={{
          width: "100%", maxWidth: 1080, maxHeight: "calc(100vh - 64px)",
          display: "flex", flexDirection: "column",
          background: "var(--card)", border: "1px solid var(--bd2)", borderRadius: 18,
          boxShadow: "var(--shadow-card-hover)", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, padding: "22px 26px 18px", borderBottom: "1px solid var(--hair)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Eyebrow style={{ marginBottom: 6, fontSize: 11 }}>client profile</Eyebrow>
            <div id="client-dialog-title" className="headline" style={{ fontSize: 26, lineHeight: 1.15, marginBottom: 8, textWrap: "balance" } as React.CSSProperties}>
              {c.name}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", color: "var(--mute)", fontSize: 13 }}>
              <span>{c.state} · {c.saa || "—"}</span>
              <PhaseChip phase={c.phase} />
              <StatusChip status={c.status} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            <Eyebrow style={{ fontSize: 10.5 }}>esc to close</Eyebrow>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
                background: "transparent", border: "1px solid var(--bd2)", borderRadius: 9,
                color: "var(--sec)", cursor: "pointer", lineHeight: 1, padding: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.color = "var(--ink)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--sec)"; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "22px 26px 26px" }}>
          {error && <Note>Could not load {row.slug}: {error}</Note>}
          {!error && !s && <Note>Loading…</Note>}
          {s && (
            <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "minmax(0, 5fr) minmax(0, 6fr)", gap: stacked ? 26 : 36, alignItems: "start" }}>
              {/* Left: who and where */}
              <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
                <div>
                  <Label>intake link</Label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--ok-bg)", border: "1px solid var(--bd2)", borderRadius: 10, padding: "8px 8px 8px 12px" }}>
                    <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--ink)" }}>
                      {c.intake_url.replace(/^https?:\/\//, "").replace(/\?t=.*/, "")}
                    </span>
                    <button type="button" onClick={() => copyLink(c.intake_url)} className="mono" style={{ fontSize: 11.5, padding: "6px 12px", borderRadius: 999, border: "1px solid var(--bd2)", background: "var(--card)", color: "var(--ink)", cursor: "pointer", whiteSpace: "nowrap" }}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <a href={c.intake_url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, padding: "6px 12px", borderRadius: 999, background: "var(--navy)", color: "var(--on-accent)", textDecoration: "none", whiteSpace: "nowrap" }}>
                      Open
                    </a>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>The copied link carries the client&rsquo;s token. Send it only to them.</div>
                </div>

                <div>
                  <Label>engagement</Label>
                  <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px", fontSize: 13.5, margin: 0 }}>
                    <dt className="mono" style={dt}>Track</dt><dd style={dd}>{c.program_track || <Faint>not set</Faint>}</dd>
                    <dt className="mono" style={dt}>Kickoff</dt><dd style={dd}>{c.kickoff_date ? `${fmtDate(c.kickoff_date, { month: "short", day: "numeric", year: "numeric" })} (Day 0)` : <span style={{ color: "var(--warn-fg)" }}>not booked</span>}</dd>
                    <dt className="mono" style={dt}>Filling it in</dt><dd style={dd}>{s.filled_by || <Faint>nobody yet</Faint>}</dd>
                    <dt className="mono" style={dt}>Last save</dt><dd style={dd}>{lastSave(c)}</dd>
                    {c.submitted_at && (<><dt className="mono" style={dt}>Submitted</dt><dd style={dd}>{s.status_line || fmtDate(c.submitted_at)}</dd></>)}
                    <dt className="mono" style={dt}>Asana</dt><dd style={dd}>{c.asana_project_gid ? <Ext href={`https://app.asana.com/0/${c.asana_project_gid}/list`}>Open project</Ext> : <Faint>not linked</Faint>}</dd>
                    <dt className="mono" style={dt}>Drive</dt>
                    <dd style={dd}>
                      {c.drive_folder_id ? <Ext href={`https://drive.google.com/drive/folders/${c.drive_folder_id}`}>Client folder</Ext> : <Faint>no client folder</Faint>}
                      {c.upload_folder_id && <> <Faint>·</Faint> <Ext href={`https://drive.google.com/drive/folders/${c.upload_folder_id}`}>Phase 2 uploads</Ext></>}
                    </dd>
                  </dl>
                </div>

                <div>
                  <Label>contacts</Label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                    {own.length === 0 && <Faint>No client contacts on file.</Faint>}
                    {own.map((x) => (
                      <div key={x.email} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "baseline" }}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontWeight: 600 }}>{x.name || x.email}</span>
                          {x.role && <span style={{ color: "var(--mute)" }}> · {x.role}</span>}
                        </span>
                        <a href={`mailto:${x.email}`} className="mono" style={{ fontSize: 11.5, color: "var(--navy)", textDecoration: "none", whiteSpace: "nowrap" }}>{x.email}</a>
                      </div>
                    ))}
                    {npsa.length > 0 && (
                      <div style={{ marginTop: 2, color: "var(--faint)", fontSize: 12 }}>
                        NPSA side: {npsa.map((x) => `${x.name.split(" ")[0]}${/rep/i.test(x.role) ? " (rep)" : ""}`).join(", ")}
                      </div>
                    )}
                  </div>
                </div>

                {s.uploads.length > 0 && (
                  <div>
                    <Label>uploads</Label>
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      {s.uploads.map((u) => (
                        <li key={u.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12 }}>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <span style={{ color: "var(--mute)" }}>{u.label}:</span>{" "}
                            {u.drive_url ? <Ext href={u.drive_url}>{u.filename}</Ext> : u.filename}
                          </span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>{fmtDate(u.uploaded_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              </div>

              {/* Right: how far along */}
              <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
                <div>
                  <Label>intake by section · {s.core.answered} of {s.core.total} core answers</Label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {s.sections.filter((x) => !/^Wish List/.test(x.section) || x.answered > 0).map((x) => (
                      <div key={x.section} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", fontSize: 13 }}>
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.section}</span>
                        <Progress a={x.answered} b={x.total} width={120} />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>checklist · {s.checklist.completed} of {s.checklist.total} completed</Label>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" }}>
                    {s.checklist.items.map((it, i) => {
                      const done = it.status === "Completed";
                      const prog = it.status === "In progress";
                      const meta = [prog ? "in progress" : "", it.due ? fmtDue(it.due) : "", it.owner].filter(Boolean).join(" · ");
                      return (
                        <li
                          key={it.stem}
                          style={{
                            display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: 12, alignItems: "center",
                            padding: "7px 0", borderTop: i ? "1px solid var(--hair2)" : undefined, fontSize: 13,
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 10, height: 10, borderRadius: "50%", justifySelf: "center",
                              border: `2px solid ${done ? "var(--ok-fg)" : prog ? "var(--warn-fg)" : "var(--bd2)"}`,
                              background: done ? "var(--ok-fg)" : prog ? "var(--warn-bg)" : "transparent",
                            }}
                          />
                          <span style={{ minWidth: 0, color: done ? "var(--mute)" : "var(--ink)", lineHeight: 1.35 }}>
                            {it.label}
                          </span>
                          <span className="mono" style={{ fontSize: 11.5, color: prog ? "var(--warn-fg)" : "var(--faint)", whiteSpace: "nowrap", textAlign: "right" }}>{meta}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
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
