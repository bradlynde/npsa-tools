/**
 * Types and fetchers for the grant knowledge base (docs/grant-knowledge.md on the
 * loe-generator branch). Everything goes through /api/grant-knowledge, the keyed
 * proxy, with the team login's token.
 */

export type Trust = "verified" | "unverified" | "stale";

/** One record as the backend returns it. `data` depends on `kind`. */
export type Rec<D = Record<string, any>> = {
  id: number;
  jurisdiction: string;
  kind: "jurisdiction" | "program" | "requirement" | "cycle" | "deadline" | "contact" | "note" | "source";
  parent_id: number | null;
  key: string;
  title: string;
  data: D;
  status: "verified" | "unverified";
  effective_status: Trust;
  unverified_fields: string[];
  verified_at: string | null;
  verified_by: string;
  source_url: string;
  origin: "import" | "research" | "manual" | "mcp";
  version: number;
  updated_at: string | null;
  updated_by: string;
  archived_at: string | null;
};

export type Requirement = Rec & { baseline?: "federal" | "state"; inherited_from?: string };
export type Cycle = Rec & { deadlines: Rec[] };
export type Program = Rec & {
  requirements: Requirement[];
  inherited_requirements: Requirement[];
  cycles: Cycle[];
  contacts: Rec[];
  notes: Rec[];
  sources: Rec[];
};

export type NextDeadline = {
  record_id: number; program: string; program_name: string; cycle: string; label: string;
  due_date: string; due_time: string | null; tz: string; instant: string; days_away: number;
  deadline_kind: string; confidence: string; status: string; open?: boolean;
};
export type CycleState = "open" | "soon" | "closed" | "unknown";
export type Freshness = { records: number; verified: number; unverified: number; stale: number; fields_to_confirm: number };

export type StateDoc = {
  code: string; name: string; jurisdiction_kind: string;
  jurisdiction: Rec | null;
  programs: Program[];
  contacts: Rec[]; notes: Rec[]; sources: Rec[];
  cycle_state: CycleState; next_deadline: NextDeadline | null;
  freshness: Freshness; open_questions: number;
};

export type OverviewRow = {
  code: string; name: string; jurisdiction_kind: string; saa: string; saa_short: string;
  programs: { key: string; name: string; type: "federal" | "state"; status: string }[];
  has_state_program: boolean; cycle_state: CycleState; next_deadline: NextDeadline | null;
  freshness: Freshness; open_questions: number;
};

export type Revision = {
  id: number; record_id: number; jurisdiction: string; kind: string; action: string; title: string;
  version_from: number | null; version_to: number; changed_fields: string[];
  before: { data: Record<string, any> } | null; after: { data: Record<string, any> };
  actor: string; actor_kind: string; reason: string; created_at: string;
};

export type Attention = {
  days: number;
  counts: Record<"unverified" | "stale" | "deadlines_soon" | "open_questions" | "missing", number>;
  deadlines_soon: (NextDeadline & { jurisdiction: string })[];
  open_questions: { record_id: number; jurisdiction: string; title: string }[];
};

export type SearchHit = { jurisdiction: string; name: string; kind: string; record_id: number; title: string; snippet: string };

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function gkGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api/grant-knowledge/${path}`, { headers: authHeaders(), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

/* ── Saying things the same way everywhere ───────────────────────── */

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const fmtDay = (iso: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", opts) : "";

const ZONE: Record<string, string> = {
  "America/New_York": "ET", "America/Detroit": "ET", "America/Indiana/Indianapolis": "ET", "America/Chicago": "CT", "America/Denver": "MT",
  "America/Boise": "MT", "America/Phoenix": "MST", "America/Los_Angeles": "PT", "America/Anchorage": "AKT", "Pacific/Honolulu": "HT",
  "America/Puerto_Rico": "AST", "America/St_Thomas": "AST", "Pacific/Guam": "ChST", "Pacific/Saipan": "ChST", "Pacific/Pago_Pago": "SST",
};
export const zoneAbbr = (tz?: string) => (tz ? ZONE[tz] || tz.split("/").pop()!.replace(/_/g, " ") : "");

/** "5:00 PM CT" from "17:00" and a zone; "" when the source gave no time. */
export function fmtTime(hhmm?: string | null, tz?: string) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ${zoneAbbr(tz)}`.trim();
}

export const countdown = (days: number) =>
  days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : days === -1 ? "yesterday" : `${-days} days ago`;

export const CYCLE_LABEL: Record<CycleState, string> = { open: "Open now", soon: "Coming up", closed: "Closed", unknown: "No dates recorded" };
