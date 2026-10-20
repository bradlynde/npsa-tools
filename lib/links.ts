/*
 * Tracked links: the Links panel on the marketing page. Every UTM link the team
 * hands out, the tag combinations that have actually turned up on bookings, and a
 * builder that shows how a booking through a new link will be credited before
 * anyone prints it on a flyer.
 *
 * How a link is credited is decided upstream, by the same code that credits real
 * bookings; this file only builds URLs and holds the presets.
 */

export type UtmTags = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
};

export type Credit = {
  channel: string;
  /** "Conference", "Instantly", "Email" ... */
  label: string;
  /** The campaign or event, when there is one: "Remarket FY27 - Non-Repliers", "CITN 2026". */
  detail: string | null;
};

type Usage = {
  bookings: number;
  /** Bookings still in the totals: not cancelled, rescheduled or a repeat. */
  counted: number;
  last_booked: string | null;
  /** How those bookings were really credited, label -> count. */
  credited_as: Record<string, number>;
};

export type SavedLink = Usage & {
  id: number;
  label: string;
  base_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string | null;
  utm_content: string | null;
  created_by: string | null;
  created_at: string;
  url: string;
  credit: Credit;
  note: string | null;
  warnings: string[];
};

export type SeenTags = Usage & {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  credit: Credit;
  note: string | null;
};

export type Preset = { label: string; url: string };

export type LinksData = {
  presets: { booking: Preset[]; site: Preset[] };
  instantly: { slug: string; name: string }[];
  saved: SavedLink[];
  seen: SeenTags[];
};

export type LinkPreview = {
  url: string | null;
  utm: Record<keyof UtmTags, string | null>;
  credit: Credit;
  note: string | null;
  warnings: string[];
};

/* ── Kinds of link ─────────────────────────────────────────────── */

export type LinkKind = "instantly" | "event" | "rep" | "social" | "linkedin" | "ads" | "custom";

/**
 * The tags each kind of link starts from. These are values the dashboard already
 * recognises; the preview confirms it either way.
 */
export const KINDS: { key: LinkKind; label: string; tags: Partial<UtmTags>; hint: string }[] = [
  { key: "instantly", label: "Instantly campaign email", tags: { utm_source: "instantly", utm_medium: "email" },
    hint: "Pick the campaign. Bookings are credited to it even if the person later moves campaigns." },
  { key: "event", label: "Conference or event", tags: { utm_medium: "in_person_event" },
    hint: "Source is who runs the event, campaign names the event (citn_2026), content is where the link was printed." },
  { key: "rep", label: "Direct email from a rep", tags: { utm_medium: "email" },
    hint: "Source is the rep's first name, e.g. jeff." },
  { key: "social", label: "Social post", tags: { utm_source: "facebook", utm_medium: "social" },
    hint: "Source is the network: facebook, instagram, youtube." },
  { key: "linkedin", label: "LinkedIn", tags: { utm_source: "linkedin", utm_medium: "post" },
    hint: "Leave the medium as post: a medium of social would count it as Social instead." },
  { key: "ads", label: "Paid ads", tags: { utm_source: "google", utm_medium: "cpc" },
    hint: "Google Ads usually tags its own links; use this for ads it does not." },
  { key: "custom", label: "Something else", tags: {},
    hint: "Any tags. The preview says how the dashboard will read them." },
];

export const EMPTY_TAGS: UtmTags = { utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "" };

/** A kind's starting tags, keeping whatever it does not set. */
export function applyKind(kind: LinkKind, current: UtmTags): UtmTags {
  const k = KINDS.find((x) => x.key === kind);
  const keep = kind === "custom" ? current : { ...current, utm_source: "", utm_medium: "" };
  return { ...keep, ...(k?.tags || {}) };
}

/** A UTM value as upstream stores it: lower case, dashes for spaces. */
export const utmSlug = (v: string): string =>
  v.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").replace(/-{2,}/g, "-");

/** The finished link, or null while the base is not a URL yet. */
export function buildUrl(base: string, tags: UtmTags): string | null {
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const) {
    const v = utmSlug(tags[k] || "");
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  return u.toString();
}

/** "Conference · CITN 2026" */
export const creditText = (c: Credit): string => (c.detail ? `${c.label} · ${c.detail}` : c.label);

/** "Instantly 4, Organic Search 1", largest first. */
export function creditedAsText(m: Record<string, number>): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

/** "church_it_network / in_person_event / citn_2026", skipping blanks. */
export const tagsText = (t: { utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }) =>
  [t.utm_source, t.utm_medium, t.utm_campaign].map((v) => v || "–").join(" / ");

/* ── API ───────────────────────────────────────────────────────── */

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(res: Response, fallback: string): Promise<never> {
  let msg = fallback;
  try {
    const b = await res.json();
    if (b?.error) msg = b.error;
  } catch {
    /* not JSON */
  }
  throw new Error(msg);
}

export async function fetchLinks(): Promise<LinksData> {
  const res = await fetch("/api/marketing/links", { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) await readError(res, `Could not load links: ${res.status}`);
  return res.json();
}

export async function previewLink(base: string, tags: UtmTags, signal?: AbortSignal): Promise<LinkPreview> {
  const q = new URLSearchParams({ base_url: base, ...tags });
  const res = await fetch(`/api/marketing/links/preview?${q}`, { headers: authHeaders(), cache: "no-store", signal });
  if (!res.ok) await readError(res, `Preview failed: ${res.status}`);
  return res.json();
}

export async function saveLink(label: string, base: string, tags: UtmTags): Promise<void> {
  const res = await fetch("/api/marketing/links", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ label, base_url: base, ...tags }),
  });
  if (!res.ok) await readError(res, `Could not save: ${res.status}`);
}

export async function deleteLink(id: number): Promise<void> {
  const res = await fetch(`/api/marketing/links/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) await readError(res, `Could not delete: ${res.status}`);
}
