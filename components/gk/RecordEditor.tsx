"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { PillButton, Eyebrow, useConfirm } from "../ui";
import Markdown from "./Markdown";
import { FIELDS, KIND_LABEL, toForm, toPatch, type Field } from "./fields";
import { gkSend, GkError, fmtDay, type Rec } from "./api";

/**
 * Editing, for every kind of record, in one dialog.
 *
 * A save sends only what changed, with the version the form was opened at. If
 * someone else saved first the backend refuses and hands back their version; the
 * dialog then shows what they changed next to what you were about to, and lets you
 * keep yours on top of theirs or take theirs. Nothing is applied ahead of the
 * server's answer.
 */

export type NewSpec = { jurisdiction: string; kind: Rec["kind"]; parent_id?: number; preset?: Record<string, any>; heading?: string };
export type EditTarget = { rec: Rec } | { create: NewSpec };

type Ctx = { on: boolean; open: (t: EditTarget) => void; move: (rec: Rec, action: "verify" | "unverify" | "archive" | "restore") => Promise<void>; home: string };
export const EditContext = createContext<Ctx>({ on: false, open: () => {}, move: async () => {}, home: "" });
export const useEdit = () => useContext(EditContext);

const input: React.CSSProperties = { width: "100%", padding: "8px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--field)", background: "var(--card)", color: "var(--ink)", fontSize: 14, lineHeight: "20px" };
const tiny: React.CSSProperties = { background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "var(--navy)" };

/** The small verbs beside a record while the page is in edit mode. */
export function RecActions({ rec, onlyEdit = false }: { rec: Rec; onlyEdit?: boolean }) {
  const { on, open, move, home } = useEdit();
  const [confirm, confirmDialog] = useConfirm();
  if (!on || rec.jurisdiction !== home) return null; // the federal baseline is edited on the federal page
  const needsVerify = rec.effective_status !== "verified" || rec.unverified_fields.length > 0;
  const archive = async () => {
    const ok = await confirm({ title: `Archive “${rec.title}”?`, body: "It leaves the page, and can be restored from History.", confirmLabel: "Archive" });
    if (ok) move(rec, "archive");
  };
  return (
    <span style={{ display: "inline-flex", gap: 10, marginLeft: 4, whiteSpace: "nowrap" }}>
      <button style={tiny} onClick={() => open({ rec })}>Edit</button>
      {!onlyEdit && needsVerify && <button style={{ ...tiny, color: "var(--ok-fg)" }} title="I have confirmed this myself" onClick={() => move(rec, "verify")}>Verify</button>}
      {!onlyEdit && rec.kind !== "jurisdiction" && <button style={{ ...tiny, color: "var(--mute)" }} title="Take out of view. Reversible from History." onClick={archive}>Archive</button>}
      {confirmDialog}
    </span>
  );
}

export function AddButton({ spec, children }: { spec: NewSpec; children: React.ReactNode }) {
  const { on, open } = useEdit();
  if (!on) return null;
  return <button onClick={() => open({ create: spec })} style={{ ...tiny, display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 0" }}><Plus size={14} strokeWidth={2} aria-hidden /> Add {children}</button>;
}

function FieldInput({ f, value, onChange }: { f: Field; value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState(false);
  if (f.type === "bool") return <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 14, color: "var(--ink)", cursor: "pointer" }}><input type="checkbox" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} />{f.label}</label>;
  if (f.type === "select") return <select value={value} onChange={(e) => onChange(e.target.value)} style={input}><option value="">{f.required ? "Choose…" : "Not set"}</option>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  if (f.type === "markdown" || f.type === "long" || f.type === "list") {
    return (
      <div>
        {f.type === "markdown" && value && <button type="button" style={{ ...tiny, float: "right", marginTop: -20 }} onClick={() => setPreview(!preview)}>{preview ? "Write" : "Preview"}</button>}
        {preview ? <div style={{ ...input, minHeight: 90 }}><Markdown>{value}</Markdown></div>
          : <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={f.type === "markdown" ? Math.min(14, Math.max(4, value.split("\n").length + 1)) : 3} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />}
      </div>
    );
  }
  return <input value={value} onChange={(e) => onChange(e.target.value)} type={f.type === "date" ? "date" : f.type === "time" ? "time" : f.type === "url" ? "url" : "text"} inputMode={f.type === "number" || f.type === "money" ? "decimal" : undefined} placeholder={f.type === "money" ? "$" : f.type === "url" ? "https://" : undefined} style={input} />;
}

export default function RecordEditor({ target, onClose, onSaved }: { target: EditTarget; onClose: () => void; onSaved: () => void }) {
  const creating = "create" in target;
  const kind = creating ? target.create.kind : target.rec.kind;
  const base = useRef<Rec | null>(creating ? null : target.rec);
  const [form, setForm] = useState<Record<string, string>>(() => toForm(kind, creating ? target.create.preset || {} : target.rec.data));
  const [key, setKey] = useState("");
  const [sourceUrl, setSourceUrl] = useState(creating ? "" : target.rec.source_url);
  const [reason, setReason] = useState("");
  const [verify, setVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Rec | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const conflictBox = useRef<HTMLDivElement>(null);
  // The Save button is at the bottom of a long form and the conflict is explained at the top.
  useEffect(() => { if (conflict) conflictBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [conflict]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeBtn.current?.focus();
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const fields = FIELDS[kind];
  const missing = fields.filter((f) => f.required && !(form[f.name] || "").trim()).map((f) => f.label);
  const needsKey = creating && kind === "program";
  const patch = toPatch(kind, base.current?.data || {}, form);
  const dirty = Object.keys(patch).length > 0 || (!creating && sourceUrl !== base.current!.source_url) || verify;

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (creating) {
        const data = Object.fromEntries(Object.entries(toPatch(kind, {}, form)).filter(([, v]) => v !== null));
        await gkSend("POST", "records", { jurisdiction: target.create.jurisdiction, kind, parent_id: target.create.parent_id, key: needsKey ? key.trim() : undefined, data, source_url: sourceUrl || undefined, reason: reason || undefined, verify });
      } else {
        await gkSend("PATCH", `records/${base.current!.id}`, { version: base.current!.version, data: patch, source_url: sourceUrl, reason: reason || undefined, verify });
      }
      onSaved();
    } catch (e) {
      if (e instanceof GkError && e.status === 409 && e.current) setConflict(e.current);
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // Their save landed first. Keep my edits on top of theirs, or drop mine.
  // "Mine" is only the fields I actually touched: everything else takes their value,
  // or saving would quietly put their change back the way it was.
  const mineOnTop = () => {
    const was = toForm(kind, base.current!.data), theirs = toForm(kind, conflict!.data);
    setForm((mine) => Object.fromEntries(Object.keys(theirs).map((k) => [k, mine[k] === was[k] ? theirs[k] : mine[k]])));
    if (sourceUrl === base.current!.source_url) setSourceUrl(conflict!.source_url);
    base.current = conflict; setConflict(null);
  };
  const takeTheirs = () => { base.current = conflict; setForm(toForm(kind, conflict!.data)); setSourceUrl(conflict!.source_url); setConflict(null); };
  const theirChanges = conflict ? fields.filter((f) => toForm(kind, conflict.data)[f.name] !== toForm(kind, base.current!.data)[f.name]) : [];

  const title = creating ? target.create.heading || `New ${KIND_LABEL[kind]}` : `Edit ${KIND_LABEL[kind]}`;
  return createPortal(
    <div onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 200, background: "var(--scrim)", display: "flex", justifyContent: "center", alignItems: "flex-start", overflowY: "auto", padding: "5vh 14px" }}>
      <div role="dialog" aria-modal="true" aria-labelledby="gk-editor-title" className="dialog" style={{ maxWidth: 760, padding: "22px 26px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
          <div>
            <Eyebrow color="var(--olive)">{creating ? target.create.jurisdiction : base.current!.jurisdiction} · {KIND_LABEL[kind]}</Eyebrow>
            <h2 id="gk-editor-title" className="serif" style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 500, color: "var(--ink)" }}>{title}</h2>
            {!creating && <div className="meta" style={{ marginTop: 3 }}>Last changed by {!base.current!.updated_by || base.current!.updated_by.startsWith("import:") ? "the import" : base.current!.updated_by}, {fmtDay(base.current!.updated_at)} · version {base.current!.version}</div>}
          </div>
          <button ref={closeBtn} onClick={onClose} aria-label="Close" className="btn btn-secondary btn-sm btn-icon"><X size={16} strokeWidth={1.75} aria-hidden /></button>
        </div>

        {conflict && (
          <div ref={conflictBox} role="alert" style={{ border: "1px solid var(--warn-fg)", background: "var(--warn-bg)", borderRadius: "var(--r-md)", padding: "12px 14px", marginBottom: 16, fontSize: 14, color: "var(--ink)" }}>
            <b>{conflict.updated_by || "Someone"} saved this record while you were editing.</b> Nothing of yours was saved yet.
            {theirChanges.length ? <ul style={{ margin: "8px 0", paddingLeft: 18 }}>{theirChanges.map((f) => <li key={f.name}><b>{f.label}:</b> now “{toForm(kind, conflict.data)[f.name].slice(0, 160) || "empty"}”</li>)}</ul> : <div style={{ margin: "6px 0" }}>They changed its status, not its fields.</div>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <PillButton tone="navy" onClick={mineOnTop}>Keep my edits on top of theirs</PillButton>
              <PillButton tone="outline" onClick={takeTheirs}>Drop mine, show theirs</PillButton>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "14px 18px" }}>
          {needsKey && (
            <div><label style={lab}>Short ID *</label><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. SCAHC, NSGP-UA" style={input} /><div style={hintStyle}>Letters, digits and dashes. How the program is named everywhere else.</div></div>
          )}
          {fields.map((f) => (
            <div key={f.name} style={{ gridColumn: f.wide || ["markdown", "long", "list"].includes(f.type) ? "1 / -1" : undefined }}>
              {f.type !== "bool" && <label style={lab}>{f.label}{f.required ? " *" : ""}</label>}
              <FieldInput f={f} value={form[f.name] ?? ""} onChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))} />
              {f.hint && <div style={hintStyle}>{f.hint}</div>}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--hair2)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "14px 18px" }}>
          <div><label style={lab}>Where this comes from</label><input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} type="url" placeholder="https:// the page that says so" style={input} /></div>
          <div><label style={lab}>Why, for the history</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. per Tammy Porter's 9/12 email" style={input} /></div>
          <label style={{ gridColumn: "1 / -1", display: "flex", gap: 9, alignItems: "flex-start", fontSize: 14, color: "var(--ink)", cursor: "pointer" }}>
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I have confirmed this myself: mark the record verified. <span style={{ color: "var(--mute)" }}>Leave it off and what you changed is flagged for someone to confirm.</span></span>
          </label>
        </div>

        {err && <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, marginTop: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18, alignItems: "center" }}>
          {missing.length > 0 && <span className="meta" style={{ marginRight: "auto" }}>Still needed: {missing.join(", ")}</span>}
          <PillButton tone="outline" onClick={onClose}>Cancel</PillButton>
          <PillButton tone="navy" onClick={save} disabled={busy || !!conflict || !dirty || missing.length > 0 || (needsKey && !key.trim())}>{busy ? "Saving…" : creating ? "Add" : "Save"}</PillButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
const lab: React.CSSProperties = { display: "block", fontSize: 13, lineHeight: "18px", fontWeight: 500, color: "var(--sec)", marginBottom: 6 };
const hintStyle: React.CSSProperties = { fontSize: 13, lineHeight: "18px", color: "var(--mute)", marginTop: 4 };
