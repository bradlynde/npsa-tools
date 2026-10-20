"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Copy, Link2, Trash2, X } from "lucide-react";
import { Button, Eyebrow, Note, useConfirm, useToast, fmtInt } from "../ui";
import {
  KINDS,
  EMPTY_TAGS,
  applyKind,
  buildUrl,
  creditText,
  creditedAsText,
  tagsText,
  fetchLinks,
  previewLink,
  saveLink,
  deleteLink,
  type LinkKind,
  type LinkPreview,
  type LinksData,
  type UtmTags,
} from "../../lib/links";

const OTHER = "__other__";

const lab: React.CSSProperties = { display: "block", fontSize: 13, lineHeight: "18px", fontWeight: 500, color: "var(--sec)", marginBottom: 6 };
const hint: React.CSSProperties = { fontSize: 13, lineHeight: "18px", color: "var(--mute)", marginTop: 4 };
const row: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 0", borderTop: "1px solid var(--hair2)", flexWrap: "wrap" };

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }) : "";

/** The "Links" button for the page header, and the panel it opens. */
export default function LinksButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" icon={Link2} onClick={() => setOpen(true)} aria-haspopup="dialog">
        Links
      </Button>
      {open && <LinksPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function LinksPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<LinksData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [toast, showToast] = useToast();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const builderRef = useRef<HTMLDivElement>(null);

  // Builder state
  const [label, setLabel] = useState("");
  const [baseChoice, setBaseChoice] = useState<string>("");
  const [customBase, setCustomBase] = useState("");
  const [kind, setKind] = useState<LinkKind>("event");
  const [tags, setTags] = useState<UtmTags>(applyKind("event", EMPTY_TAGS));
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const base = baseChoice === OTHER ? customBase : baseChoice;

  const load = useCallback(() => {
    fetchLinks()
      .then((d) => {
        setData(d);
        setErr(null);
        setBaseChoice((b) => b || d.presets.booking[0]?.url || OTHER);
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  // Escape closes; focus starts on the close button and goes back when done.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="alertdialog"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  // Live preview, asked of the same code that credits real bookings.
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      previewLink(base, tags, ctl.signal).then(setPreview).catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [base, tags]);

  const url = buildUrl(base, tags);
  const setTag = (k: keyof UtmTags) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setTags((t) => ({ ...t, [k]: e.target.value }));

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Link copied");
    } catch {
      showToast("Could not copy. Select the link and copy it by hand.");
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      await saveLink(label, base, tags);
      showToast("Link saved");
      setLabel("");
      load();
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number, name: string) => {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: "Only the saved entry goes. Bookings already made through the link keep their credit, and the link itself keeps working.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteLink(id);
      load();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  /** Starts the builder from tags seen on bookings, to register them as a link. */
  const startFrom = (t: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }) => {
    setKind("custom");
    setTags({ utm_source: t.utm_source || "", utm_medium: t.utm_medium || "", utm_campaign: t.utm_campaign || "", utm_content: "" });
    setLabel("");
    builderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const kindInfo = KINDS.find((k) => k.key === kind)!;
  const missing = [!label.trim() && "a name", !url && "a link", !tags.utm_source.trim() && "a source", !tags.utm_medium.trim() && "a medium"].filter(Boolean);

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "var(--scrim)", display: "flex", justifyContent: "center", alignItems: "flex-start", overflowY: "auto", padding: "5vh 14px" }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="links-title" className="dialog" style={{ maxWidth: 880, padding: "22px 26px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <div>
            <Eyebrow color="var(--olive)">Marketing</Eyebrow>
            <h2 id="links-title" className="serif" style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 500, color: "var(--ink)" }}>
              Tracked links
            </h2>
          </div>
          <button ref={closeBtn} onClick={onClose} aria-label="Close" className="btn btn-secondary btn-sm btn-icon">
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="meta" style={{ marginBottom: 18 }}>
          Build a link before it goes on a flyer or in an email, and see how its bookings will be credited.
        </div>

        {/* ── Builder ── */}
        <div ref={builderRef} style={{ scrollMarginTop: 20 }}>
          <h3 className="section-title" style={{ marginBottom: 12 }}>New link</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "14px 18px" }}>
            <div>
              <label style={lab} htmlFor="lk-label">Name</label>
              <input id="lk-label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. CITN 2026 printed flyer" />
            </div>
            <div>
              <label style={lab} htmlFor="lk-kind">Where it will be used</label>
              <select
                id="lk-kind"
                className="field"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as LinkKind;
                  setKind(k);
                  setTags((t) => applyKind(k, t));
                }}
              >
                {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lab} htmlFor="lk-base">Link to</label>
              <select id="lk-base" className="field" value={baseChoice} onChange={(e) => setBaseChoice(e.target.value)}>
                {data && (
                  <>
                    <optgroup label="Booking links the dashboard tracks">
                      {data.presets.booking.map((p) => <option key={p.url} value={p.url}>{p.label}</option>)}
                    </optgroup>
                    <optgroup label="Website">
                      {data.presets.site.map((p) => <option key={p.url} value={p.url}>{p.label}</option>)}
                    </optgroup>
                  </>
                )}
                <option value={OTHER}>Another URL…</option>
              </select>
              {baseChoice === OTHER && (
                <input className="field" style={{ marginTop: 8 }} value={customBase} onChange={(e) => setCustomBase(e.target.value)} placeholder="https://" aria-label="URL" type="url" />
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px 18px", marginTop: 14 }}>
            <div>
              <label style={lab} htmlFor="lk-src">Source</label>
              <input id="lk-src" className="field mono" value={tags.utm_source} onChange={setTag("utm_source")} placeholder={kind === "rep" ? "jeff" : kind === "event" ? "church_it_network" : ""} />
            </div>
            <div>
              <label style={lab} htmlFor="lk-med">Medium</label>
              <input id="lk-med" className="field mono" value={tags.utm_medium} onChange={setTag("utm_medium")} />
            </div>
            <div>
              <label style={lab} htmlFor="lk-camp">Campaign</label>
              {kind === "instantly" && data ? (
                <select id="lk-camp" className="field" value={tags.utm_campaign} onChange={setTag("utm_campaign")}>
                  <option value="">Choose a campaign…</option>
                  {data.instantly.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>
              ) : (
                <input id="lk-camp" className="field mono" value={tags.utm_campaign} onChange={setTag("utm_campaign")} placeholder={kind === "event" ? "citn_2026" : "optional"} />
              )}
            </div>
            <div>
              <label style={lab} htmlFor="lk-content">Content</label>
              <input id="lk-content" className="field mono" value={tags.utm_content} onChange={setTag("utm_content")} placeholder={kind === "event" ? "printed_material" : "optional"} />
            </div>
          </div>
          <div style={hint}>{kindInfo.hint}</div>

          {/* Preview */}
          <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: "var(--r-md)", background: "var(--bg)", border: "1px solid var(--hair2)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="meta">Bookings through this link count as</span>
              <b style={{ color: "var(--ink)", fontSize: 15 }}>{preview ? creditText(preview.credit) : "…"}</b>
            </div>
            {preview?.note && <div style={{ ...hint, marginTop: 6 }}>{preview.note}</div>}
            {preview?.warnings.map((w) => (
              <div key={w} role="alert" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, fontSize: 13, lineHeight: "18px", color: "var(--warn-fg)" }}>
                <AlertTriangle size={15} strokeWidth={1.75} aria-hidden style={{ flex: "none", marginTop: 1 }} />
                <span>{w}</span>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <code className="mono" style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: "18px", color: url ? "var(--ink)" : "var(--faint)", overflowWrap: "anywhere" }}>
                {url || "Pick or paste a link to build the URL"}
              </code>
              <Button variant="secondary" size="sm" icon={Copy} disabled={!url} onClick={() => url && copy(url)}>Copy</Button>
            </div>
          </div>

          {saveErr && <div role="alert" style={{ color: "var(--err-fg)", fontSize: 13, marginTop: 10 }}>{saveErr}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 12 }}>
            {missing.length > 0 && <span className="meta" style={{ marginRight: "auto" }}>To save it, add {missing.join(", ")}.</span>}
            <Button onClick={save} busy={saving} disabled={saving || missing.length > 0}>Save link</Button>
          </div>
        </div>

        {/* ── Saved ── */}
        <div style={{ marginTop: 26 }}>
          <h3 className="section-title" style={{ marginBottom: 4 }}>Saved links</h3>
          {err ? (
            <Note>{err}</Note>
          ) : !data ? (
            <Note>Loading…</Note>
          ) : data.saved.length === 0 ? (
            <Note>No links saved yet. Save one above and it will be listed here with its bookings.</Note>
          ) : (
            data.saved.map((l) => (
              <div key={l.id} style={row}>
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 500, color: "var(--ink)" }}>{l.label}</div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    {creditText(l.credit)} · <span className="mono">{tagsText(l)}</span>
                  </div>
                  <code className="mono" style={{ display: "block", marginTop: 4, fontSize: 12, lineHeight: "17px", color: "var(--mute)", overflowWrap: "anywhere" }}>{l.url}</code>
                  {l.warnings.map((w) => (
                    <div key={w} style={{ display: "flex", gap: 6, marginTop: 4, fontSize: 12, lineHeight: "17px", color: "var(--warn-fg)" }}>
                      <AlertTriangle size={13} strokeWidth={1.75} aria-hidden style={{ flex: "none", marginTop: 2 }} />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
                <div style={{ flex: "0 0 auto", textAlign: "right", minWidth: 110 }}>
                  <div style={{ fontSize: 15, color: "var(--ink)" }}>{fmtInt(l.bookings)} {l.bookings === 1 ? "booking" : "bookings"}</div>
                  {l.bookings > 0 && <div className="meta">last {fmtDay(l.last_booked)}</div>}
                  {l.created_by && <div className="meta">added by {l.created_by}</div>}
                </div>
                <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
                  <Button variant="secondary" size="sm" icon={Copy} onClick={() => copy(l.url)} aria-label={`Copy ${l.label}`} />
                  <Button variant="quiet" size="sm" icon={Trash2} onClick={() => remove(l.id, l.label)} aria-label={`Delete ${l.label}`} />
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Seen ── */}
        {data && data.seen.length > 0 && (
          <div style={{ marginTop: 26 }}>
            <h3 className="section-title" style={{ marginBottom: 2 }}>Tags seen on bookings</h3>
            <div className="meta" style={{ marginBottom: 4 }}>
              Every tag combination that has turned up on a booking and is not a saved link. A typo or an unregistered link shows up here.
            </div>
            {data.seen.map((s) => (
              <div key={tagsText(s)} style={row}>
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 14, color: "var(--ink)", overflowWrap: "anywhere" }}>{tagsText(s)}</div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    Reads as {creditText(s.credit)}
                    {Object.keys(s.credited_as).length > 0 && <> · credited {creditedAsText(s.credited_as)}</>}
                  </div>
                  {/* Why some of them sit elsewhere, when they do. */}
                  {s.note && Object.keys(s.credited_as).some((k) => k !== s.credit.label) && (
                    <div style={{ ...hint, fontSize: 12, lineHeight: "17px", marginTop: 2 }}>{s.note}</div>
                  )}
                </div>
                <div style={{ flex: "0 0 auto", textAlign: "right", minWidth: 110 }}>
                  <div style={{ fontSize: 15, color: "var(--ink)" }}>{fmtInt(s.bookings)} {s.bookings === 1 ? "booking" : "bookings"}</div>
                  <div className="meta">last {fmtDay(s.last_booked)}</div>
                </div>
                <div style={{ flex: "0 0 auto" }}>
                  <Button variant="secondary" size="sm" onClick={() => startFrom(s)}>Save as link</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {confirmDialog}
      {toast}
    </div>,
    document.body
  );
}
