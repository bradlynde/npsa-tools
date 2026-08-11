import { useEffect, useState } from "react";

/*
 * The curated NSGP deadline table.
 *
 * Brad's note on the City Church briefing: "This is innacurate. IN has announced
 * the sub applicant deadline for 2026 NSGP. Also, this entire section doesn't have
 * much value unless we also provide the three most recent NSGP IN Sub-Applicant
 * Deadlines." Both halves of that are a maintenance problem rather than a research
 * problem — the dates are published, they just have to be written down somewhere
 * the tool reads. This is that somewhere.
 *
 * Whoever keeps it current can see where each date came from, which is the point of
 * the source column: a date with no provenance is the thing that got us here.
 */

const blank = { state: "", program: "federal", cycleYear: new Date().getFullYear(), deadline: "", kind: "sub_applicant", note: "", source: "", confidence: "confirmed" };

const inputStyle = {
  border: "1px solid var(--bd2)", borderRadius: 7, padding: "6px 9px", fontSize: 12.5,
  outline: "none", boxSizing: "border-box", width: "100%", fontFamily: "var(--font-sans)",
};
const th = { fontSize: 10.5, fontWeight: 700, color: "var(--mute)", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left", padding: "0 6px 6px" };
const td = { padding: "3px 6px", verticalAlign: "top" };

export default function DeadlineEditor({ onClose }) {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({ ...blank });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/precall/deadlines");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.deadlines || []);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async (row) => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/precall/deadlines", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDraft({ ...blank });
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const remove = async (id) => {
    setBusy(true);
    try { await fetch(`/api/precall/deadlines/${id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,0.45)", zIndex: 60,
                  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div style={{ background: "var(--bg)", borderRadius: 16, maxWidth: 940, width: "100%",
                    boxShadow: "0 18px 50px rgba(2,6,23,0.3)", padding: "22px 26px 26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)" }}>NSGP Deadlines</div>
          <button onClick={onClose}
            style={{ marginLeft: "auto", background: "var(--card)", border: "1px solid var(--bd)", borderRadius: 8,
                     padding: "7px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--sec)", cursor: "pointer" }}>
            Close
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--mute)", marginBottom: 16, lineHeight: 1.5 }}>
          These dates go straight into the briefing. Use <strong>state</strong> for a sub-applicant
          deadline (the date the nonprofit must submit to the SAA) and <strong>US</strong> for the
          federal FEMA-to-SAA date. Keeping the last three cycles per state is what makes the
          projection meaningful — with fewer than two recorded, the notes say so rather than guess.
          <br />
          Seeded from the grant-knowledge folder in Drive, then checked against each agency's own
          published material on 8 August 2026 — that pass moved four dates, Texas by five months.
          A row marked <strong>verify</strong> is one nothing corroborated, or one the Drive file
          itself flags as needing checking each cycle; the briefing still prints it, but says so.
          Promote it to <strong>confirmed</strong> once you have checked it against the SAA.
          Editing any row marks it <strong>yours</strong>, and nothing automated will overwrite it again.
        </div>

        {error && (
          <div style={{ color: "var(--err-fg)", background: "var(--err-bg)", border: "1px solid var(--err-fg)",
                        borderRadius: 8, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 62 }}>State</th>
              <th style={{ ...th, width: 96 }}>Program</th>
              <th style={{ ...th, width: 72 }}>FY</th>
              <th style={{ ...th, width: 128 }}>Deadline</th>
              <th style={{ ...th, width: 96 }}>Confidence</th>
              <th style={th}>Note</th>
              <th style={th}>Source</th>
              <th style={{ ...th, width: 64 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ background: "var(--card)" }}>
                <td style={td}><strong style={{ fontSize: 12.5 }}>{r.state}</strong></td>
                <td style={{ ...td, fontSize: 12 }}>{r.program}</td>
                <td style={{ ...td, fontSize: 12 }}>FY{r.cycle_year}</td>
                <td style={{ ...td, fontSize: 12 }}>{r.deadline || <em style={{ color: "var(--faint)" }}>none</em>}</td>
                <td style={td}>
                  {/* A date the source itself flags "verify each cycle" still goes in
                      the briefing, but labelled — a rep should see which they have. */}
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
                                 color: r.confidence === "illustrative" ? "var(--warn-fg)" : "var(--ok-fg)",
                                 background: r.confidence === "illustrative" ? "var(--warn-bg)" : "var(--ok-bg)",
                                 border: `1px solid ${r.confidence === "illustrative" ? "var(--warn-bg)" : "var(--ok-bg)"}` }}>
                    {r.confidence === "illustrative" ? "verify" : "confirmed"}
                  </span>
                </td>
                <td style={{ ...td, fontSize: 11.5, color: "var(--sec)" }}>{r.note}</td>
                <td style={{ ...td, fontSize: 11, color: "var(--mute)", wordBreak: "break-all" }}>
                  {r.source}
                  {/* Which layer a row came from decides who may overwrite it, so it
                      is worth being able to see at a glance. */}
                  {r.layer && r.layer !== "knowledge-base" && (
                    <div style={{ marginTop: 3, fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                                  textTransform: "uppercase",
                                  color: r.layer === "manual" ? "var(--navy)" : "var(--navy)" }}>
                      {r.layer === "manual" ? "edited here" : "web-checked"}
                    </div>
                  )}
                </td>
                <td style={td}>
                  <button onClick={() => remove(r.id)} disabled={busy}
                    style={{ background: "none", border: "1px solid var(--err-fg)", color: "var(--err-fg)", borderRadius: 6,
                             padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td style={td}><input style={inputStyle} placeholder="IN" maxLength={2}
                value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value.toUpperCase() })} /></td>
              <td style={td}><input style={inputStyle} placeholder="federal"
                value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} /></td>
              <td style={td}><input style={inputStyle} type="number"
                value={draft.cycleYear} onChange={(e) => setDraft({ ...draft, cycleYear: e.target.value })} /></td>
              <td style={td}><input style={inputStyle} type="date"
                value={draft.deadline} onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} /></td>
              <td style={td}>
                <select style={inputStyle} value={draft.confidence}
                  onChange={(e) => setDraft({ ...draft, confidence: e.target.value })}>
                  <option value="confirmed">confirmed</option>
                  <option value="illustrative">verify</option>
                </select>
              </td>
              <td style={td}><input style={inputStyle} placeholder="Submit to IDHS by 4:00 p.m. ET"
                value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></td>
              <td style={td}><input style={inputStyle} placeholder="in.gov/dhs/…"
                value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></td>
              <td style={td}>
                <button onClick={() => save(draft)} disabled={busy || !draft.state}
                  style={{ background: busy || !draft.state ? "var(--faint)" : "var(--navy)", color: "var(--card)", border: "none",
                           borderRadius: 6, padding: "6px 12px", fontSize: 11.5, fontWeight: 700,
                           cursor: busy || !draft.state ? "default" : "pointer" }}>
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ fontSize: 11.5, color: "var(--mute)", marginTop: 12 }}>
          Adding a state and fiscal year that already exists updates that row rather than duplicating it.
        </div>
      </div>
    </div>
  );
}
