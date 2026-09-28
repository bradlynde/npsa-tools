import { applicationYear, byState, filterApplications, shadeFor, yearsIn } from "./applications.ts";
import type { Application } from "./marketing.ts";

const a = (o: Partial<Application>): Application => ({
  application_id: "x", name: null, organization: "Org", grant_program: "2026 NSGP", state: "CA",
  status: "Preparing", status_bucket: "preparing", amount_requested: 0, amount_awarded: 0, max_award: 0, updated_at: null, ...o,
});

const results: string[] = [];
const ok = (n: string, got: any, want: any) => {
  const p = JSON.stringify(got) === JSON.stringify(want);
  results.push(p ? "P" : "F");
  console.log(`${p ? "PASS" : "FAIL"}  ${n}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

ok("A  year from the program name", ["2026 NSGP-IL", "2026 FPC (GA State Grant)", "2025 CSNSGP", "NSGP", null].map(applicationYear), ["2026", "2026", "2025", null, null]);
ok("A2 years newest first, no duplicates", yearsIn([a({ grant_program: "2025 NSGP" }), a({ grant_program: "2027 NSGP" }), a({}), a({ grant_program: "NSGP" })]), ["2027", "2026", "2025"]);

const apps = [
  a({ application_id: "1", state: "CA", status_bucket: "awarded", amount_awarded: 150000, grant_program: "2025 NSGP", organization: "B" }),
  a({ application_id: "2", state: "CA", status_bucket: "pending", amount_requested: 90000, organization: "A" }),
  a({ application_id: "3", state: "ca", status_bucket: "preparing", organization: "Z" }),
  a({ application_id: "4", state: "FL", status_bucket: "cancelled" }),
  a({ application_id: "5", state: "MN", status_bucket: "resubmitted", grant_program: "2025 NSGP" }),
  a({ application_id: "6", state: null }),
];

ok("B  cancelled hidden by default", filterApplications(apps, { year: "all", showCancelled: false }).map((x) => x.application_id), ["1", "2", "3", "5", "6"]);
ok("B2 and shown when asked", filterApplications(apps, { year: "all", showCancelled: true }).length, 6);
ok("B3 year filter", filterApplications(apps, { year: "2025", showCancelled: false }).map((x) => x.application_id), ["1", "5"]);

const m = byState(filterApplications(apps, { year: "all", showCancelled: false }));
const ca = m.get("CA")!;
ok("C  lower-case state folds into CA", ca.total, 3);
ok("C2 counts by status", [ca.counts.preparing, ca.counts.pending, ca.counts.awarded], [1, 1, 1]);
ok("C3 won money and submitted money", [ca.awarded, ca.pending], [150000, 90000]);
ok("C4 list in status order: preparing, submitted, won", ca.apps.map((x) => x.application_id), ["3", "2", "1"]);
ok("C5 no FL once cancelled is hidden; blank state kept apart", [m.has("FL"), m.get("")?.total], [false, 1]);

ok("D  shades step up with the count", [0, 1, 2, 3, 6, 16, 56].map(shadeFor), [
  "var(--track)",
  "color-mix(in srgb, var(--navy) 38%, var(--track))", "color-mix(in srgb, var(--navy) 38%, var(--track))",
  "color-mix(in srgb, var(--navy) 57%, var(--track))", "color-mix(in srgb, var(--navy) 78%, var(--track))",
  "var(--navy)", "var(--navy)",
]);

console.log(`\n${results.filter((r) => r === "P").length}/${results.length} passed`);
process.exit(results.includes("F") ? 1 : 0);
