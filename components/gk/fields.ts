/**
 * What the editor shows for each kind of record. The backend's schemas
 * (server/grant-knowledge-kinds.js on loe-generator) are the authority on what is
 * allowed; this is only how to ask for it. A dotted name is a field inside an
 * object ("submission.url").
 */
export type FieldType = "text" | "long" | "markdown" | "number" | "money" | "bool" | "select" | "date" | "time" | "list" | "url";
export type Field = { name: string; label: string; type: FieldType; options?: [string, string][]; hint?: string; required?: boolean; wide?: boolean };

const ZONES: [string, string][] = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona (no DST)"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"], ["America/Boise", "Mountain (Boise)"],
  ["America/Detroit", "Eastern (Detroit)"], ["America/Indiana/Indianapolis", "Eastern (Indianapolis)"], ["America/Puerto_Rico", "Atlantic (PR)"],
  ["America/St_Thomas", "Atlantic (VI)"], ["Pacific/Guam", "Chamorro (Guam)"], ["Pacific/Saipan", "Chamorro (Saipan)"], ["Pacific/Pago_Pago", "Samoa"],
];
const PHASES: [string, string][] = [["before_nofo", "Before the NOFO"], ["registration", "Registration"], ["application", "Building the application"], ["submission", "Submission"], ["post_award", "After the award"]];
const CONFIDENCE: [string, string][] = [["confirmed", "Confirmed"], ["illustrative", "Illustrative: verify"], ["projected", "Projected from past cycles"]];

export const FIELDS: Record<string, Field[]> = {
  jurisdiction: [
    { name: "saa", label: "State Administrative Agency", type: "text", wide: true },
    { name: "saa_short", label: "Short name", type: "text" },
    { name: "saa_url", label: "Agency page", type: "url" },
    { name: "default_tz", label: "Time zone deadlines are in", type: "select", options: ZONES },
    { name: "urban_areas", label: "FEMA urban areas", type: "list", hint: "One per line", wide: true },
    { name: "partner", label: "Partner", type: "text", wide: true },
    { name: "cycle_status", label: "Where the cycle stands", type: "text", wide: true },
    { name: "cycle_timing_note", label: "When the next cycle is expected", type: "markdown" },
    { name: "summary_md", label: "Summary", type: "markdown", hint: "The two or three sentences a new writer should read first" },
    { name: "post_award_note", label: "After the award", type: "markdown" },
  ],
  program: [
    { name: "name", label: "Program name", type: "text", required: true, wide: true },
    { name: "type", label: "Funded by", type: "select", options: [["federal", "Federal (FEMA pass-through)"], ["state", "The state"]], required: true },
    { name: "status", label: "Status", type: "select", options: [["active", "Active"], ["dormant", "Dormant"], ["unconfirmed", "Unconfirmed"], ["dead", "Dead"]] },
    { name: "administered_by", label: "Run by", type: "text", wide: true },
    { name: "availability_note", label: "Availability note", type: "long" },
    { name: "cap_per_location", label: "Cap per site", type: "money" },
    { name: "cap_per_applicant", label: "Cap per applicant", type: "money" },
    { name: "locations_max", label: "Sites allowed", type: "number" },
    { name: "ma_pct", label: "M&A percent", type: "number" },
    { name: "cost_match", label: "Cost match", type: "text" },
    { name: "pop_months", label: "Period of performance, months", type: "number" },
    { name: "pop_note", label: "Period of performance note", type: "text", wide: true },
    { name: "stackable", label: "Stacks with federal NSGP", type: "select", options: [["true", "Yes"], ["false", "No"], ["verify", "Unconfirmed"]] },
    { name: "exclusive_with", label: "Cannot also win", type: "list", hint: "Program keys, one per line" },
    { name: "inherits_from", label: "Same requirements as", type: "text", hint: "A program key, e.g. NSGP-S" },
    { name: "deadline_authority", label: "Whose deadline binds", type: "text" },
    { name: "submission.method", label: "Submitted by", type: "text", hint: "portal, email, salesforce…" },
    { name: "submission.platform", label: "Portal platform", type: "text", hint: "eGrants, WebGrants, ZoomGrants…" },
    { name: "submission.target", label: "Submitted to", type: "text", wide: true },
    { name: "submission.url", label: "Portal address", type: "url", wide: true },
    { name: "submission.package_note", label: "How the package goes in", type: "markdown" },
    { name: "file_naming", label: "File naming", type: "long" },
    { name: "eligible_costs", label: "Eligible costs", type: "markdown" },
    { name: "notes_md", label: "Program notes", type: "markdown" },
  ],
  requirement: [
    { name: "label", label: "What is required", type: "text", required: true, wide: true },
    { name: "req_type", label: "Kind", type: "select", options: [["registration", "Registration step"], ["document", "Document in the package"]], required: true },
    { name: "owner", label: "Who does it", type: "select", options: [["client", "Client"], ["npsa", "NPSA"]] },
    { name: "hard_gate", label: "Hard gate (nothing moves without it)", type: "bool" },
    { name: "lead_time_days", label: "Allow, in days", type: "number" },
    { name: "format", label: "Format", type: "text" },
    { name: "phase", label: "Phase", type: "select", options: PHASES },
    { name: "url", label: "Where to do it", type: "url" },
    { name: "notes", label: "Notes", type: "long" },
    { name: "client_label", label: "Wording on the client's page", type: "text", wide: true },
    { name: "client_hint", label: "Hint on the client's page", type: "long" },
  ],
  cycle: [
    { name: "fiscal_year", label: "Fiscal year", type: "number", required: true },
    { name: "label", label: "Label", type: "text", hint: "FY2027, SFY27, 2026 round" },
    { name: "status", label: "Status", type: "select", options: [["pre_nofo", "Before the NOFO"], ["open", "Open"], ["closed", "Closed"], ["awaiting_awards", "Awaiting awards"], ["awarded", "Awarded"]] },
    { name: "confidence", label: "Confidence", type: "select", options: CONFIDENCE },
    { name: "nofo_date", label: "NOFO released", type: "date" },
    { name: "open_date", label: "Window opened", type: "date" },
    { name: "total_funding", label: "Total funding", type: "money" },
    { name: "state_allocation", label: "State allocation", type: "money" },
    { name: "applications", label: "Applications", type: "number" },
    { name: "awards", label: "Awards", type: "number" },
    { name: "award_total", label: "Awarded, total", type: "money" },
    { name: "notes", label: "Notes", type: "long" },
  ],
  deadline: [
    { name: "label", label: "What is due", type: "text", required: true, wide: true },
    { name: "due_date", label: "Date", type: "date", required: true },
    { name: "due_time", label: "Time", type: "time", hint: "Leave empty if the source gives none" },
    { name: "tz", label: "Zone", type: "select", options: ZONES, hint: "Empty uses the state's zone" },
    { name: "deadline_kind", label: "Kind", type: "select", options: [["sub_applicant", "Application to the SAA"], ["stage", "One stage of several"], ["noi", "Notice of intent"], ["registration", "Registration closes"], ["questions", "Questions due"], ["state_program", "State program"], ["fema", "SAA to FEMA"]] },
    { name: "stage_order", label: "Order among stages", type: "number" },
    { name: "confidence", label: "Confidence", type: "select", options: CONFIDENCE },
    { name: "note", label: "Note", type: "long" },
  ],
  contact: [
    { name: "name", label: "Name", type: "text" },
    { name: "role", label: "Role", type: "text" },
    { name: "org", label: "Agency or office", type: "text", wide: true },
    { name: "email", label: "Email", type: "text" },
    { name: "phone", label: "Phone", type: "text" },
    { name: "contact_kind", label: "Kind", type: "select", options: [["saa", "SAA"], ["program", "Program"], ["cisa_psa", "CISA protective security advisor"], ["partner", "Partner"], ["helpdesk", "Help desk"], ["other", "Other"]] },
    { name: "area", label: "Area covered", type: "text" },
    { name: "is_primary", label: "The first person to call", type: "bool" },
    { name: "last_confirmed", label: "Last confirmed", type: "date" },
    { name: "warning", label: "Caveat", type: "long", hint: "e.g. no longer on the public page; reconfirm" },
    { name: "notes", label: "Notes", type: "long" },
  ],
  note: [
    { name: "title", label: "In one line", type: "text", required: true, wide: true },
    { name: "category", label: "Category", type: "select", required: true, options: [["gotcha", "Gotcha"], ["eligibility", "Eligibility"], ["scoring", "Scoring"], ["prohibited_cost", "Prohibited cost"], ["process", "Process"], ["history", "History and patterns"], ["post_award", "Post-award"], ["watch_item", "Watch item"], ["open_question", "Open question"]] },
    { name: "severity", label: "Severity", type: "select", options: [["info", "Good to know"], ["caution", "Caution"], ["critical", "Critical"], ["auto_disqualifier", "Ends the application"]] },
    { name: "phase", label: "Phase", type: "select", options: PHASES },
    { name: "body_md", label: "The detail", type: "markdown" },
    { name: "client_slug", label: "Learned on (client slug)", type: "text", hint: "e.g. greenland-hills-umc" },
    { name: "observed_on", label: "When", type: "date" },
    { name: "resolved", label: "Resolved (open questions)", type: "bool" },
  ],
  source: [
    { name: "url", label: "Address", type: "url", required: true, wide: true },
    { name: "title", label: "Title", type: "text", wide: true },
    { name: "publisher", label: "Publisher", type: "text" },
    { name: "accessed", label: "Read on", type: "date" },
    { name: "covers", label: "What it covers", type: "text", wide: true },
  ],
};

export const KIND_LABEL: Record<string, string> = { jurisdiction: "state record", program: "program", requirement: "requirement", cycle: "cycle", deadline: "deadline", contact: "contact", note: "note", source: "source" };

const get = (o: Record<string, any>, path: string) => path.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), o);

/** Record data → the strings a form edits. */
export function toForm(kind: string, data: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const v = get(data, f.name);
    out[f.name] = v === undefined || v === null ? "" : f.type === "list" ? (v as string[]).join("\n") : String(v);
  }
  return out;
}

/** What changed, as a patch the backend merges: null clears a field; an object field is sent whole. */
export function toPatch(kind: string, before: Record<string, any>, form: Record<string, string>): Record<string, unknown> {
  const was = toForm(kind, before);
  const patch: Record<string, unknown> = {};
  const parse = (f: Field, s: string): unknown => {
    const t = s.trim();
    if (!t) return null;
    if (f.type === "number" || f.type === "money") return Number(t.replace(/[$,\s]/g, ""));
    if (f.type === "bool") return t === "true";
    if (f.type === "list") return t.split("\n").map((x) => x.trim()).filter(Boolean);
    if (f.name === "stackable") return t === "true" ? true : t === "false" ? false : "verify";
    return f.type === "markdown" || f.type === "long" ? s.replace(/\s+$/, "") : t;
  };
  for (const f of FIELDS[kind]) {
    if ((form[f.name] ?? "") === was[f.name]) continue;
    const [head, sub] = f.name.split(".");
    if (!sub) { patch[head] = parse(f, form[f.name] ?? ""); continue; }
    const obj = { ...((patch[head] as Record<string, unknown>) ?? before[head] ?? {}) };
    const v = parse(f, form[f.name] ?? "");
    if (v === null) delete obj[sub]; else obj[sub] = v;
    patch[head] = Object.keys(obj).length ? obj : null;
  }
  return patch;
}
