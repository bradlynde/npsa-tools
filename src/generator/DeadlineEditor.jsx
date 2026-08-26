import { useEffect, useMemo, useState } from "react";

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
 * It used to render every jurisdiction's every cycle in one list, which is around
 * 200 rows: unreadable, and no way to answer the only question a maintainer
 * actually has — "is the state on my call current?". So it opens on a grid of
 * jurisdictions and then shows ONE state at a time, with the rest of what applies
 * to that state beside its dates: the administering agency, the state-funded
 * programs that stack with the federal award, and when each layer was last checked.
 *
 * Whoever keeps it current can see where each date came from, which is the point of
 * the source column: a date with no provenance is the thing that got us here.
 */

const blank = { state: "", program: "federal", cycleYear: new Date().getFullYear(), deadline: "", kind: "sub_applicant", note: "", source: "", confidence: "confirmed" };

const inputStyle = {
  border: "1px solid var(--bd2)", borderRadius: 7, padding: "7px 9px", fontSize: 12.5,
  outline: "none", boxSizing: "border-box", width: "100%", fontFamily: "var(--font-sans)",
};
const th = { fontSize: 10.5, fontWeight: 700, color: "var(--mute)", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left", padding: "0 8px 6px" };
const td = { padding: "8px", verticalAlign: "top", borderTop: "1px solid var(--hair2)" };
const label = { fontSize: 10, fontWeight: 700, color: "var(--mute)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 };
const sectionTitle = { fontSize: 12, fontWeight: 800, color: "var(--ink)", letterSpacing: 0.3, marginBottom: 8 };

/* Which layer a row came from decides who may overwrite it, so it is worth
   being able to see at a glance. */
const LAYER = {
  manual: { text: "edited here", tone: "var(--navy)" },
  verified: { text: "web-checked", tone: "var(--navy)" },
  "knowledge-base": { text: "from Drive", tone: "var(--faint)" },
};

const PROGRAM_TITLE = { federal: "Federal NSGP", "federal-noi": "Federal NSGP — notice of intent" };

function fmtStamp(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
const money = (n) => (typeof n === "number" ? `$${n.toLocaleString("en-US")}` : String(n || ""));

export default function DeadlineEditor({ onClose, initialState = "" }) {
  const [rows, setRows] = useState([]);
  const [reference, setReference] = useState({ states: {}, checkedOn: "", notCovered: [] });
  const [picked, setPicked] = useState((initialState || "").trim().toUpperCase());
  const [draft, setDraft] = useState(null);   // null = the add/edit form is closed
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/precall/deadlines");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.deadlines || []);
      if (d.reference) setReference(d.reference);
    } catch (e) { setError(e.message); }
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  /* Every jurisdiction with either a recorded date or a knowledge-base entry.
     US is FEMA's own deadline to the states and bounds all of them, so it leads. */
  const jurisdictions = useMemo(() => {
    const set = new Set([...Object.keys(reference.states || {}), ...rows.map((r) => r.state)]);
    set.delete("US");
    return ["US", ...[...set].filter(Boolean).sort()];
  }, [rows, reference]);

  const byState = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.state] ||= []).push(r);
    return m;
  }, [rows]);

  const save = async (row) => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/precall/deadlines", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDraft(null);
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

  const stateRows = picked ? (byState[picked] || []) : [];
  const ref = (reference.states || {})[picked];

  /* Grouped by program, federal first: a state's own program is a different pot of
     money on a different calendar, not another row of the same list. */
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of stateRows) {
      if (!m.has(r.program)) m.set(r.program, []);
      m.get(r.program).push(r);
    }
    for (const list of m.values()) list.sort((a, b) => b.cycle_year - a.cycle_year);
    const keys = [...m.keys()].sort((a, b) => {
      const fa = a.startsWith("federal") ? 0 : 1, fb = b.startsWith("federal") ? 0 : 1;
      return fa - fb || a.localeCompare(b);
    });
    return keys.map((k) => [k, m.get(k)]);
  }, [stateRows]);

  const lastEdit = stateRows.reduce((acc, r) => (r.updated_at && (!acc || r.updated_at > acc) ? r.updated_at : acc), "");
  const programsWithoutDates = (ref?.programs || []).filter((p) => !groups.some(([k]) => k === p.acronym));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(8,12,20,0.6)", zIndex: 60,
                  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      {/*
        The panel is --card, not --bg. In dark mode --bg is the page behind it, so
        the dialog had no edge at all: the table appeared to float on the screen it
        was covering. Card, a hairline and a real shadow give it the same popout in
        both themes.
      */}
      <div style={{ background: "var(--card)", borderRadius: 16, maxWidth: 980, width: "100%",
                    border: "1px solid var(--bd)", boxShadow: "0 24px 60px rgba(2,6,23,0.45)",
                    padding: "22px 26px 26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)" }}>NSGP Deadlines</div>
          <select value={picked} onChange={(e) => { setPicked(e.target.value); setDraft(null); }}
            style={{ ...inputStyle, width: "auto", minWidth: 210, fontWeight: 600 }}>
            <option value="">All jurisdictions</option>
            {jurisdictions.map((s) => {
              const n = (byState[s] || []).length;
              return <option key={s} value={s}>{s === "US" ? "US — FEMA to states" : s}{n ? ` — ${n} recorded` : " — none recorded"}</option>;
            })}
          </select>
          <button onClick={onClose}
            style={{ marginLeft: "auto", background: "var(--bg)", border: "1px solid var(--bd)", borderRadius: 8,
                     padding: "7px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--sec)", cursor: "pointer" }}>
            Close
          </button>
        </div>

        <div style={{ fontSize: 12.5, color: "var(--mute)", marginBottom: 16, lineHeight: 1.5 }}>
          These dates go straight into the briefing. Use a <strong>state</strong> for a sub-applicant
          deadline (the date the nonprofit must submit to the SAA) and <strong>US</strong> for the
          federal FEMA-to-SAA date. Keeping the last three cycles per state is what makes the
          projection meaningful — with fewer than two recorded, the notes say so rather than guess.
          A row marked <strong>verify</strong> is one nothing corroborated, or one the Drive file
          itself flags as needing checking each cycle; the briefing still prints it, but says so.
          Editing any row marks it <strong>yours</strong>, and nothing automated will overwrite it again.
        </div>

        {error && (
          <div style={{ color: "var(--err-fg)", background: "var(--err-bg)", border: "1px solid var(--err-fg)",
                        borderRadius: 8, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
        )}

        {/* ── No state chosen: the grid, so "which states are thin?" is one look ── */}
        {!picked && (
          <div>
            <div style={sectionTitle}>Choose a jurisdiction</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 8 }}>
              {jurisdictions.map((s) => {
                const list = byState[s] || [];
                const unverified = list.filter((r) => r.confidence === "illustrative").length;
                return (
                  <button key={s} onClick={() => setPicked(s)}
                    style={{ background: "var(--bg)", border: "1px solid var(--bd)", borderRadius: 10,
                             padding: "10px 11px", textAlign: "left", cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>{s}</div>
                    <div style={{ fontSize: 11, color: list.length ? "var(--sec)" : "var(--faint)", marginTop: 2 }}>
                      {list.length ? `${list.length} date${list.length === 1 ? "" : "s"}` : "none recorded"}
                    </div>
                    {unverified > 0 && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--warn-fg)", marginTop: 2 }}>
                        {unverified} to verify
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {loaded && !rows.length && (
              <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 12 }}>No deadlines are recorded yet.</div>
            )}
            {(reference.notCovered || []).length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 12 }}>
                Not covered by the knowledge base: {reference.notCovered.join(", ")}.
              </div>
            )}
          </div>
        )}

        {/* ── One state ── */}
        {picked && (
          <div>
            {/* Freshness, stated as the three separate claims it actually is. */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--bd)", borderRadius: 12,
                          padding: "12px 14px", display: "grid", gap: 12, marginBottom: 16,
                          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <div>
                <div style={label}>Administering agency</div>
                <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.4 }}>
                  {picked === "US" ? "FEMA — deadline for State Administering Agencies"
                    : ref?.saa || <span style={{ color: "var(--faint)" }}>not recorded</span>}
                </div>
              </div>
              <div>
                <div style={label}>Drive file verified</div>
                <div style={{ fontSize: 12.5, color: ref?.lastVerified ? "var(--ink)" : "var(--faint)" }}>
                  {ref?.lastVerified || "—"}
                </div>
              </div>
              <div>
                <div style={label}>Web check</div>
                <div style={{ fontSize: 12.5, color: "var(--ink)" }}>{fmtStamp(reference.checkedOn) || "—"}</div>
              </div>
              <div>
                <div style={label}>Last edit in this table</div>
                <div style={{ fontSize: 12.5, color: lastEdit ? "var(--ink)" : "var(--faint)" }}>{fmtStamp(lastEdit) || "—"}</div>
              </div>
            </div>

            {groups.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: 16 }}>
                No cycles recorded for {picked}. The briefing will say so rather than guess a date.
              </div>
            )}

            {groups.map(([program, list]) => {
              const p = (ref?.programs || []).find((x) => x.acronym === program);
              return (
                <div key={program} style={{ marginBottom: 18 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <div style={sectionTitle}>{PROGRAM_TITLE[program] || p?.name || program}</div>
                    {p && (
                      <div style={{ fontSize: 11.5, color: "var(--sec)" }}>
                        {money(p.perSite)}/site{p.perApplicant ? ` · ${money(p.perApplicant)} per applicant` : ""}
                        {p.stackable === true ? " · stacks with federal NSGP"
                          : p.stackable === false ? " · does not stack with federal NSGP"
                          : " · stacking to verify"}
                      </div>
                    )}
                  </div>
                  {p && (p.note || p.availabilityNote || p.exclusiveWith || p.administeredBy) && (
                    <div style={{ fontSize: 11.5, color: p.dormant || p.unconfirmed ? "var(--warn-fg)" : "var(--sec)",
                                  background: p.dormant || p.unconfirmed ? "var(--warn-bg)" : "var(--bg)",
                                  border: "1px solid var(--hair)", borderRadius: 8, padding: "8px 10px",
                                  marginBottom: 8, lineHeight: 1.45 }}>
                      {p.administeredBy && <div>Administered by {p.administeredBy}.</div>}
                      {p.exclusiveWith?.length > 0 && <div>Only one award per fiscal year across this and {p.exclusiveWith.join(", ")}.</div>}
                      {p.availabilityNote && <div>{p.availabilityNote}</div>}
                      {p.note && <div>{p.note}</div>}
                    </div>
                  )}
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, width: 66 }}>FY</th>
                        <th style={{ ...th, width: 116 }}>Deadline</th>
                        <th style={{ ...th, width: 92 }}>Confidence</th>
                        <th style={th}>Note</th>
                        <th style={{ ...th, width: 168 }}>Source</th>
                        <th style={{ ...th, width: 112 }}>Updated</th>
                        <th style={{ ...th, width: 108 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <tr key={r.id}>
                          <td style={{ ...td, fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>FY{r.cycle_year}</td>
                          <td style={{ ...td, fontSize: 12.5, color: "var(--ink)" }}>
                            {r.deadline || <em style={{ color: "var(--faint)" }}>none</em>}
                          </td>
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
                          <td style={{ ...td, fontSize: 11.5, color: "var(--sec)", lineHeight: 1.45 }}>{r.note}</td>
                          <td style={{ ...td, fontSize: 11, color: "var(--mute)", wordBreak: "break-all" }}>{r.source}</td>
                          <td style={{ ...td, fontSize: 11, color: "var(--mute)" }}>
                            {fmtStamp(r.updated_at) || "—"}
                            {r.layer && LAYER[r.layer] && (
                              <div style={{ marginTop: 3, fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                                            textTransform: "uppercase", color: LAYER[r.layer].tone }}>
                                {LAYER[r.layer].text}
                              </div>
                            )}
                          </td>
                          <td style={td}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => setDraft({
                                state: r.state, program: r.program, cycleYear: r.cycle_year,
                                deadline: r.deadline || "", kind: r.kind, note: r.note || "",
                                source: r.source || "", confidence: r.confidence || "confirmed",
                              })}
                                style={{ background: "none", border: "1px solid var(--bd2)", color: "var(--sec)", borderRadius: 6,
                                         padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                                Edit
                              </button>
                              <button onClick={() => remove(r.id)} disabled={busy}
                                style={{ background: "none", border: "1px solid var(--err-fg)", color: "var(--err-fg)", borderRadius: 6,
                                         padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}

            {/* A state programme with a published cap but no cycle recorded is money a
                rep can still raise on the call, so it is shown rather than omitted. */}
            {programsWithoutDates.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={sectionTitle}>State-funded programs — no cycle recorded</div>
                {programsWithoutDates.map((p) => (
                  <div key={p.acronym} style={{ background: "var(--bg)", border: "1px solid var(--hair)", borderRadius: 10,
                                                padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{p.name} <span style={{ color: "var(--mute)", fontWeight: 600 }}>({p.acronym})</span></div>
                    <div style={{ fontSize: 11.5, color: "var(--sec)", marginTop: 3 }}>
                      {money(p.perSite)}/site{p.perApplicant ? ` · ${money(p.perApplicant)} per applicant` : ""}
                      {p.dormant ? " · dormant" : p.unconfirmed ? " · not confirmed as enacted" : ""}
                    </div>
                    {(p.availabilityNote || p.note) && (
                      <div style={{ fontSize: 11.5, color: "var(--mute)", marginTop: 4, lineHeight: 1.45 }}>
                        {p.availabilityNote || p.note}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── Add / edit, scoped to the state on screen ── */}
            {!draft ? (
              <button onClick={() => setDraft({ ...blank, state: picked })}
                style={{ background: "var(--navy)", color: "var(--on-accent)", border: "none", borderRadius: 8,
                         padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                Add a cycle for {picked}
              </button>
            ) : (
              <div style={{ background: "var(--bg)", border: "1px solid var(--bd)", borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ ...sectionTitle, marginBottom: 10 }}>
                  {picked} — {draft.program} FY{draft.cycleYear}
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                  <div>
                    <div style={label}>Program</div>
                    <input style={inputStyle} list="npsa-programs" placeholder="federal"
                      value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} />
                    <datalist id="npsa-programs">
                      <option value="federal" />
                      {(ref?.programs || []).map((p) => <option key={p.acronym} value={p.acronym} />)}
                    </datalist>
                  </div>
                  <div>
                    <div style={label}>Fiscal year</div>
                    <input style={inputStyle} type="number"
                      value={draft.cycleYear} onChange={(e) => setDraft({ ...draft, cycleYear: e.target.value })} />
                  </div>
                  <div>
                    <div style={label}>Deadline</div>
                    <input style={inputStyle} type="date"
                      value={draft.deadline} onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} />
                  </div>
                  <div>
                    <div style={label}>Confidence</div>
                    <select style={inputStyle} value={draft.confidence}
                      onChange={(e) => setDraft({ ...draft, confidence: e.target.value })}>
                      <option value="confirmed">confirmed</option>
                      <option value="illustrative">verify</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 10 }}>
                  <div>
                    <div style={label}>Note</div>
                    <input style={inputStyle} placeholder="Submit to IDHS by 4:00 p.m. ET"
                      value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                  </div>
                  <div>
                    <div style={label}>Source</div>
                    <input style={inputStyle} placeholder="in.gov/dhs/…"
                      value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                  <button onClick={() => save({ ...draft, state: picked })} disabled={busy}
                    style={{ background: busy ? "var(--faint)" : "var(--navy)", color: "var(--on-accent)", border: "none",
                             borderRadius: 8, padding: "8px 16px", fontSize: 12.5, fontWeight: 700,
                             cursor: busy ? "default" : "pointer" }}>
                    Save
                  </button>
                  <button onClick={() => setDraft(null)}
                    style={{ background: "var(--card)", border: "1px solid var(--bd)", borderRadius: 8, padding: "8px 14px",
                             fontSize: 12.5, fontWeight: 600, color: "var(--sec)", cursor: "pointer" }}>
                    Cancel
                  </button>
                  <div style={{ fontSize: 11.5, color: "var(--mute)" }}>
                    Saving a program and fiscal year that already exists updates that row rather than duplicating it.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
