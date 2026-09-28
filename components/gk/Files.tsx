"use client";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Tag, useConfirm } from "../ui";
import { useEdit } from "./RecordEditor";
import { gkSend, gkUpload, fmtDay, fmtSize, type GkFile } from "./api";

/**
 * The files kept for one jurisdiction: a NOFO, an SAA's own checklist, a
 * screenshot of the step in the portal nobody can ever find again.
 *
 * The file does not go through this app's own API routes, whose functions cap a
 * body at 4.5 MB; gkUpload asks the backend for a ticket and posts it there
 * directly. What that means here is that a 20 MB PDF works, and that the link to
 * read one back is minted per page load and expires — so the list is fetched
 * again after every change rather than patched in place.
 */

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx";
const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, color: "var(--navy)", cursor: "pointer", fontSize: 13, fontWeight: 500 };

export default function Files({ code, files, onChanged }: { code: string; files: GkFile[]; onChanged: () => void }) {
  const { on } = useEdit();
  const [confirm, confirmDialog] = useConfirm();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function send(list: FileList | File[] | null) {
    const chosen = Array.from(list || []);
    if (!chosen.length) return;
    setErr(null);
    // One at a time, and the label goes on the first only: a label describes a
    // document, and two files dropped together are two documents.
    for (const [i, file] of chosen.entries()) {
      setBusy(`Sending ${file.name}…`);
      try { await gkUpload(file, { jurisdiction: code, label: i === 0 ? label.trim() : "" }); }
      catch (e) { setErr(`${file.name}: ${(e as Error).message}`); break; }
    }
    setBusy(null);
    setLabel("");
    if (picker.current) picker.current.value = "";
    onChanged();
  }

  async function archive(f: GkFile) {
    const ok = await confirm({ title: `Take “${f.label || f.filename}” out of ${code}?`, body: "It can be put back.", confirmLabel: "Archive file" });
    if (!ok) return;
    setErr(null); setBusy(`Archiving ${f.filename}…`);
    try { await gkSend("POST", `files/${f.id}/archive`, {}); }
    catch (e) { setErr((e as Error).message); }
    setBusy(null);
    onChanged();
  }

  if (!files.length && !on) return null;

  return (
    <div className="gk-rows">
      {err && <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {files.map((f) => (
        <div key={f.id} id={`file-${f.id}`} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", padding: "9px 0", borderBottom: "1px solid var(--hair2)" }}>
          <Tag>{f.type_name}</Tag>
          <div style={{ minWidth: 0, flex: "1 1 220px" }}>
            <div style={{ fontSize: 14, color: "var(--ink)", wordBreak: "break-word" }}>
              {f.download_url
                ? <a href={f.download_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)" }}>{f.label || f.filename}</a>
                : (f.label || f.filename)}
              {f.label && <span style={{ color: "var(--mute)", fontSize: 13 }}> · {f.filename}</span>}
            </div>
            <div className="meta" style={{ marginTop: 2 }}>
              {fmtSize(f.size_bytes)}
              {f.uploaded_by && ` · ${f.uploaded_by}`}
              {f.uploaded_at && `, ${fmtDay(f.uploaded_at)}`}
              {f.source_url && <> · <a href={f.source_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)" }}>where it came from</a></>}
              {f.drive_url && <> · <a href={f.drive_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--navy)" }}>in Drive</a></>}
            </div>
          </div>
          {on && <button style={{ ...linkBtn, color: "var(--mute)" }} onClick={() => archive(f)}>Archive</button>}
        </div>
      ))}

      {confirmDialog}
      {on && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
          style={{
            border: `1px dashed ${over ? "var(--olive)" : "var(--line-strong)"}`, borderRadius: "var(--r-md)", padding: "14px 16px", marginTop: 12,
            display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", background: over ? "var(--ok-bg)" : "transparent",
          }}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is it? (optional)"
            aria-label="A name for the file"
            className="field field-sm"
            style={{ flex: "1 1 200px", width: "auto" }}
          />
          <input ref={picker} type="file" accept={ACCEPT} multiple onChange={(e) => send(e.target.files)} style={{ display: "none" }} />
          <button style={{ ...linkBtn, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => picker.current?.click()} disabled={!!busy}>
            {busy || <><Plus size={14} strokeWidth={2} aria-hidden /> Choose a file, or drop one here</>}
          </button>
          <span className="meta">PDF, JPG, PNG, Word or Excel, up to 25 MB</span>
        </div>
      )}
    </div>
  );
}
