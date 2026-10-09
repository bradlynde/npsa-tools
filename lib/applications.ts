import type { Application, ApplicationBucket } from "./marketing";

/**
 * The applications map on the Company Report: grouping Salesforce applications
 * by state and grant year. Pure, so lib/applications.test.mts can run it.
 */

/** Display order and wording. "pending" is Salesforce's "Submitted", awaiting the award notification. */
export const BUCKETS: { key: ApplicationBucket; label: string }[] = [
  { key: "preparing", label: "Preparing" },
  { key: "pending", label: "Submitted" },
  { key: "awarded", label: "Won" },
  { key: "denied", label: "Denied" },
  { key: "resubmitted", label: "Resubmitting" },
  { key: "cancelled", label: "Cancelled" },
];
export const BUCKET_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label])) as Record<ApplicationBucket, string>;

/** The grant year a program belongs to: "2026 NSGP-IL" is 2026. Null when the program names none. */
export const applicationYear = (program: string | null): string | null => /\b(20\d\d)\b/.exec(program || "")?.[1] ?? null;

/** Years present, newest first, for the filter chips. */
export const yearsIn = (apps: Application[]): string[] =>
  [...new Set(apps.map((a) => applicationYear(a.grant_program)).filter((y): y is string => !!y))].sort().reverse();

export type AppFilter = { year: string; showCancelled: boolean };

/** Applications passing the year filter ("all" for every year) and the cancelled toggle. */
export const filterApplications = (apps: Application[], f: AppFilter): Application[] =>
  apps.filter(
    (a) =>
      (f.showCancelled || a.status_bucket !== "cancelled") &&
      (f.year === "all" || applicationYear(a.grant_program) === f.year)
  );

export type StateSummary = {
  code: string;
  total: number;
  counts: Record<ApplicationBucket, number>;
  /** Money brought in: awarded amounts on won applications. */
  awarded: number;
  /** Money still in play: amounts requested on submitted applications. */
  pending: number;
  apps: Application[];
};

const zero = (): Record<ApplicationBucket, number> => ({ preparing: 0, pending: 0, awarded: 0, denied: 0, resubmitted: 0, cancelled: 0 });

const ORDER = Object.fromEntries(BUCKETS.map((b, i) => [b.key, i])) as Record<ApplicationBucket, number>;

/**
 * One summary per state, keyed by USPS code. A state's list runs in status order
 * (preparing first, cancelled last), then newest program, then organization.
 * Applications with no state are grouped under "".
 */
export function byState(apps: Application[]): Map<string, StateSummary> {
  const out = new Map<string, StateSummary>();
  for (const a of apps) {
    const code = (a.state || "").trim().toUpperCase();
    let s = out.get(code);
    if (!s) out.set(code, (s = { code, total: 0, counts: zero(), awarded: 0, pending: 0, apps: [] }));
    s.total++;
    s.counts[a.status_bucket] = (s.counts[a.status_bucket] || 0) + 1;
    if (a.status_bucket === "awarded") s.awarded += a.amount_awarded || 0;
    if (a.status_bucket === "pending") s.pending += a.amount_requested || 0;
    s.apps.push(a);
  }
  for (const s of out.values())
    s.apps.sort(
      (x, y) =>
        ORDER[x.status_bucket] - ORDER[y.status_bucket] ||
        (y.grant_program || "").localeCompare(x.grant_program || "") ||
        (x.organization || "").localeCompare(y.organization || "")
    );
  return out;
}

/** Shade steps for the map: darker means more applications. Fixed, so the legend never moves. */
export const SHADES: { min: number; label: string; mix: number }[] = [
  { min: 16, label: "16 or more", mix: 100 },
  { min: 6, label: "6 to 15", mix: 78 },
  { min: 3, label: "3 to 5", mix: 57 },
  { min: 1, label: "1 or 2", mix: 38 },
];

export const shadeFor = (n: number): string => {
  if (!n) return "var(--track)";
  const step = SHADES.find((s) => n >= s.min)!;
  return step.mix === 100 ? "var(--navy)" : `color-mix(in srgb, var(--navy) ${step.mix}%, var(--track))`;
};
