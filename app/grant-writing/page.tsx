"use client";

import { useEffect, useMemo, useState } from "react";
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
  contacts: Contact[];
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

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 980px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
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

function Quiet({ row }: { row: ClientRow }) {
  const d = daysSince(row.last_client_activity_at);
  if (d === null) return <span style={{ color: "var(--faint)", fontSize: 12.5 }}>no saves yet</span>;
  const color = row.status !== "active" ? "var(--mute)" : d > 30 ? "var(--err-fg)" : d > 14 ? "var(--warn-fg)" : "var(--ok-fg)";
  return (
    <span className="mono" style={{ color, fontWeight: 600, fontSize: 12.5 }}>
      {d}
      <span style={{ color: "var(--faint)", fontWeight: 400 }}> d</span>
    </span>
  );
}

function Progress({ a, b, width = 88 }: { a: number; b: number; width?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width, display: "inline-block" }}>
        <Bar pct={pct(a, b)} color="var(--olive)" height={6} radius={3} animate={false} />
      </span>
      <span className="mono" style={{ fontSize: 12, color: "var(--sec)", fontVariantNumeric: "tabular-nums" }}>
        {a}/{b}
      </span>
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Eyebrow style={{ marginBottom: 8, fontSize: 11 }}>{children}</Eyebrow>
  );
}

/* ── The page ─────────────────────────────────────────────────── */

export default function GrantWritingPage() {
  const [filter, setFilter] = useState<Filter>("active");
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ client: ClientRow; status: Status } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const narrow = useIsNarrow();

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

  useEffect(() => {
    if (!selected && visible.length) setSelected(visible[0].slug);
    if (selected && rows && !rows.some((r) => r.slug === selected)) setSelected(visible[0]?.slug || null);
  }, [visible, rows, selected]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let live = true;
    setDetailError(null);
    Promise.all([getJson<ClientRow>(`/api/clients/${selected}`), getJson<Status>(`/api/clients/${selected}/status`)])
      .then(([client, status]) => { if (live) setDetail({ client, status }); })
      .catch((e) => { if (live) { setDetail(null); setDetailError(e.message); } });
    return () => { live = false; };
  }, [selected]);

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

  const copyLink = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <Page>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 26 }}>
        <PageHeading eyebrow={`grant writing · in-house clients · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toLowerCase()}`}>
          Every client, <em>where they stand.</em>
        </PageHeading>
        <div style={{ fontSize: 13, color: "var(--mute)", maxWidth: 420 }}>
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

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0, 1.55fr) minmax(340px, 1fr)", gap: 18, alignItems: "start" }}>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--hair)", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span className="headline" style={{ fontSize: 20 }}>Clients</span>
              <SegPill<Filter>
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[{ key: "active", label: "Active" }, { key: "submitted", label: "Submitted" }, { key: "all", label: "All" }]}
              />
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, slug or state"
              className="mono"
              style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 999, border: "1px solid var(--bd2)", background: "var(--bg)", color: "var(--ink)", minWidth: 220 }}
            />
          </div>

          {error && <Note>Could not load clients: {error}</Note>}
          {!error && rows === null && <Note>Loading…</Note>}
          {!error && rows !== null && visible.length === 0 && <Note>No clients match.</Note>}
          {!error && visible.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
                <thead>
                  <tr>
                    {["Client", "State", "Phase", "Status", "Intake", "Checklist", "Quiet"].map((h) => (
                      <th key={h} className="mono" style={{ textAlign: "left", fontWeight: 600, fontSize: 10.5, letterSpacing: ".08em", color: "var(--faint)", padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}>
                        {h.toLowerCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const on = r.slug === selected;
                    return (
                      <tr
                        key={r.slug}
                        onClick={() => setSelected(r.slug)}
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(r.slug); } }}
                        aria-selected={on}
                        style={{ cursor: "pointer", background: on ? "var(--ok-bg)" : undefined, boxShadow: on ? "inset 3px 0 0 var(--olive)" : undefined }}
                        onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--hover)"; }}
                        onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = ""; }}
                      >
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)" }}>
                          <div style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name}</div>
                          <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{r.slug}</div>
                        </td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}>
                          {r.state} <span style={{ color: "var(--faint)" }}>· {r.saa || "—"}</span>
                        </td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}>
                          <Pill fg="var(--sec)" bg="var(--q-bg)">{r.phase} · {PHASE[r.phase] || "?"}</Pill>
                        </td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)" }}><StatusChip status={r.status} /></td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}><Progress a={r.core.answered} b={r.core.total} /></td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}><Progress a={r.checklist.completed} b={r.checklist.total} /></td>
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid var(--hair)", whiteSpace: "nowrap" }}><Quiet row={r} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card style={{ padding: "20px 22px" }}>
          {!selected && <Note>Select a client.</Note>}
          {selected && detailError && <Note>Could not load {selected}: {detailError}</Note>}
          {selected && !detail && !detailError && <Note>Loading…</Note>}
          {detail && (() => {
            const c = detail.client;
            const s = detail.status;
            const npsa = c.contacts.filter((x) => x.side === "npsa");
            const own = c.contacts.filter((x) => x.side !== "npsa");
            const quiet = daysSince(c.last_client_activity_at);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <Label>client profile</Label>
                  <div className="headline" style={{ fontSize: 24, marginBottom: 4 }}>{c.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--mute)", fontSize: 13 }}>
                    <span>{c.state} · {c.saa || "—"}</span>
                    <Pill fg="var(--sec)" bg="var(--q-bg)">{c.phase} · {PHASE[c.phase]}</Pill>
                    <StatusChip status={c.status} />
                  </div>
                </div>

                <div>
                  <Label>intake link</Label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--ok-bg)", border: "1px solid var(--bd2)", borderRadius: 10, padding: "8px 10px" }}>
                    <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--ink)" }}>
                      {c.intake_url.replace(/^https?:\/\//, "").replace(/t=.*/, "t=…")}
                    </span>
                    <button type="button" onClick={() => copyLink(c.intake_url)} className="mono" style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--bd2)", background: "var(--card)", color: "var(--ink)", cursor: "pointer" }}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <a href={c.intake_url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 999, background: "var(--navy)", color: "var(--on-accent)", textDecoration: "none" }}>
                      Open
                    </a>
                  </div>
                </div>

                <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 13.5, margin: 0 }}>
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Track</dt><dd style={{ margin: 0 }}>{c.program_track || <span style={{ color: "var(--faint)" }}>not set</span>}</dd>
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Kickoff</dt><dd style={{ margin: 0 }}>{c.kickoff_date ? `${fmtDate(c.kickoff_date, { month: "short", day: "numeric", year: "numeric" })} (Day 0)` : <span style={{ color: "var(--warn-fg)" }}>not booked</span>}</dd>
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Filling it in</dt><dd style={{ margin: 0 }}>{s.filled_by || <span style={{ color: "var(--faint)" }}>nobody yet</span>}</dd>
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Last save</dt><dd style={{ margin: 0 }}>{quiet === null ? "never" : quiet === 0 ? "today" : `${quiet} days ago`}</dd>
                  {c.submitted_at && (<><dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Submitted</dt><dd style={{ margin: 0 }}>{s.status_line || fmtDate(c.submitted_at)}</dd></>)}
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Asana</dt><dd style={{ margin: 0 }}>{c.asana_project_gid ? <a href={`https://app.asana.com/0/${c.asana_project_gid}/list`} target="_blank" rel="noreferrer" style={{ color: "var(--navy)" }}>Open project</a> : <span style={{ color: "var(--faint)" }}>not linked</span>}</dd>
                  <dt className="mono" style={{ color: "var(--faint)", fontSize: 11.5 }}>Drive</dt>
                  <dd style={{ margin: 0 }}>
                    {c.drive_folder_id ? <a href={`https://drive.google.com/drive/folders/${c.drive_folder_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--navy)" }}>Client folder</a> : <span style={{ color: "var(--faint)" }}>no folder</span>}
                    {c.upload_folder_id && <> · <a href={`https://drive.google.com/drive/folders/${c.upload_folder_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--navy)" }}>Phase 2</a></>}
                  </dd>
                </dl>

                <div>
                  <Label>intake by section</Label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {s.sections.filter((x) => !/^Wish List/.test(x.section) || x.answered > 0).map((x) => (
                      <div key={x.section} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
                        <span>{x.section}</span>
                        <Progress a={x.answered} b={x.total} width={110} />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>checklist · {s.checklist.completed} of {s.checklist.total} completed</Label>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    {s.checklist.items.map((it) => {
                      const done = it.status === "Completed";
                      const prog = it.status === "In progress";
                      return (
                        <li key={it.stem} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", gap: 10, alignItems: "center" }}>
                          <span style={{ width: 10, height: 10, borderRadius: "50%", border: `2px solid ${done ? "var(--ok-fg)" : prog ? "var(--warn-fg)" : "var(--bd2)"}`, background: done ? "var(--ok-fg)" : prog ? "var(--warn-bg)" : "transparent" }} />
                          <span style={{ color: done ? "var(--mute)" : "var(--ink)" }}>{it.label}</span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>{[it.status !== "Not started" ? it.status : "", it.due, it.owner].filter(Boolean).join(" · ")}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {s.uploads.length > 0 && (
                  <div>
                    <Label>uploads</Label>
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }}>
                      {s.uploads.map((u) => (
                        <li key={u.id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <span>{u.label}: {u.drive_url ? <a href={u.drive_url} target="_blank" rel="noreferrer" style={{ color: "var(--navy)" }}>{u.filename}</a> : u.filename}</span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{fmtDate(u.uploaded_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <Label>contacts</Label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    {own.length === 0 && <span style={{ color: "var(--faint)" }}>No client contacts on file.</span>}
                    {own.map((x) => (
                      <div key={x.email} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <span><span style={{ fontWeight: 600 }}>{x.name || x.email}</span>{x.role && <span style={{ color: "var(--mute)" }}> · {x.role}</span>}</span>
                        <a href={`mailto:${x.email}`} className="mono" style={{ fontSize: 11.5, color: "var(--navy)", textDecoration: "none" }}>{x.email}</a>
                      </div>
                    ))}
                    {npsa.length > 0 && (
                      <div style={{ marginTop: 4, color: "var(--faint)", fontSize: 12 }}>
                        NPSA side: {npsa.map((x) => x.name.split(" ")[0]).join(", ")}
                      </div>
                    )}
                  </div>
                </div>

                {c.notes && (
                  <div>
                    <Label>notes</Label>
                    <div style={{ fontSize: 12.5, color: "var(--sec)", whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{c.notes}</div>
                  </div>
                )}
              </div>
            );
          })()}
        </Card>
      </div>
    </Page>
  );
}
