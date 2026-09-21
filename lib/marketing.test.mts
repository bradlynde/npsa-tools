import { bookingsInRange, campaignsInRange, centralDate, channelsInRange, creditedOn, feesInRange, priorTotalsFor,
  priorWindow, rangeWindow, totalsFor, windowLabel, type BookingRow, type TimeseriesRow } from "./marketing.ts";

const b = (o: Partial<BookingRow>): BookingRow => ({
  id: 0, booked_on: "2026-08-18", meeting_date: "2026-08-20", name: "n",
  organization: "o", email: "e", told_us: null, attribution_channel: "instantly",
  instantly_campaign: null, instantly_campaign_id: null, host: null,
  held: true, became_client: false, fee: 0, won: false, won_amount: 0, ...o,
});

const results: string[] = [];
const ok = (n: string, got: any, want: any) => {
  const p = JSON.stringify(got) === JSON.stringify(want);
  results.push(p ? "P" : "F");
  console.log(`${p ? "PASS" : "FAIL"}  ${n}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// THE CASE: a dead name and the live name are one campaign, and must be one row.
let rows = campaignsInRange([
  b({ id: 1, instantly_campaign: "Remarket FY27 - Non-Repliers (excl IL, CA)" }),
  b({ id: 2, instantly_campaign: "Remarket FY27 - Non-Repliers",
      instantly_campaign_id: "8552c05f-c927-48ee-b654-66f33e1c5cf1" }),
], "all");
ok("A  dead name folds into the live campaign", rows.length, 1);
ok("A2 under the live name", rows[0].campaign, "Remarket FY27 - Non-Repliers");
ok("A3 with both bookings", rows[0].booked, 2);

// A rename where NEITHER row has an id yet -- both carry names, one of them dead.
rows = campaignsInRange([
  b({ id: 3, instantly_campaign: "IL Outreach - Uncontacted (6-step)" }),
  b({ id: 4, instantly_campaign: "IL Outreach - Uncontacted" }),
], "all");
ok("B  folds on the dead-name map alone, with no ids", rows.length, 1);
ok("B2 and counts both", rows[0].booked, 2);

// Two genuinely different campaigns must NOT merge.
rows = campaignsInRange([
  b({ id: 5, instantly_campaign: "Broader Church Campaign - Phase 1",
      instantly_campaign_id: "a2a95058-21b8-41c4-8c39-a340976e66d3" }),
  b({ id: 6, instantly_campaign: "Christian Schools Campaign",
      instantly_campaign_id: "5512076f-4e51-4c44-b032-2cc11dff2d66" }),
], "all");
ok("C  distinct campaigns stay distinct", rows.length, 2);

// Source rows still behave: no campaign, not Instantly.
rows = campaignsInRange([
  b({ id: 7, instantly_campaign: null, attribution_channel: "direct" }),
  b({ id: 8, instantly_campaign: null, attribution_channel: "instantly" }),
], "all");
ok("D  a non-campaign booking is a source row",
   rows.map(r => [r.campaign, r.isCampaign]).sort(),
   [["Direct / Other", false], ["Instantly — campaign unknown", false]].sort());

// THE ONE THAT MATTERS FOR NEXT TIME: a rename nobody has catalogued. Two rows,
// same id, different names, neither in the dead-name map -- they still fold,
// because the id decides the name rather than the other way round.
rows = campaignsInRange([
  b({ id: 9,  instantly_campaign: "Some Campaign (old name)",
      instantly_campaign_id: "11111111-2222-3333-4444-555555555555" }),
  b({ id: 10, instantly_campaign: "Some Campaign",
      instantly_campaign_id: "11111111-2222-3333-4444-555555555555" }),
], "all");
ok("E  an uncatalogued rename folds on the id alone", rows.length, 1);
ok("E2 and both bookings land on it", rows[0].booked, 2);

// RESCHEDULES: credited to the day the appointment was first set, not the day it
// moved. A replacement row's own booked_on is the day of the reschedule. Dates are
// pinned to a fixed "today" so the calendar windows are deterministic.
const TODAY = "2026-09-21";
const moved = b({ id: 11, booked_on: "2026-09-18T15:00:00Z", originated_on: "2026-08-10T15:00:00Z", became_client: true, fee: 9500 });
const fresh = b({ id: 12, booked_on: "2026-09-18T15:00:00Z", became_client: true, fee: 4000 });
const original = b({ id: 13, booked_on: "2026-08-10T15:00:00Z", exclusion_reason: "rescheduled", cancelled: true });

ok("F  creditedOn uses the origin when there is one", creditedOn(moved), "2026-08-10T15:00:00Z");
ok("F2 and booked_on when the row replaced nothing", creditedOn(b({ booked_on: "2026-09-18", originated_on: null })), "2026-09-18");
ok("F3 and booked_on from a backend that does not send the field yet", creditedOn(b({ booked_on: "2026-09-18" })), "2026-09-18");

const set = [moved, fresh, original];
const ids = (r: BookingRow[]) => r.map(x => x.id).sort((x, y) => x - y);
const booked = (r: { booked: number }[]) => r.reduce((n, x) => n + x.booked, 0);
ok("G  this month: list holds the new booking only", ids(bookingsInRange(set, "month", TODAY)), [12]);
ok("G2 this month: channel table counts one", booked(channelsInRange(set, "month", TODAY)), 1);
ok("G3 this month: campaign table counts one", booked(campaignsInRange(set, "month", TODAY)), 1);
ok("G4 this month: fees leave out the moved client's", feesInRange(set, "month", TODAY), 4000);
ok("G5 last month: the moved meeting and its original, not September's", ids(bookingsInRange(set, "lastmonth", TODAY)), [11, 13]);
ok("G6 last month: the moved client's fee, the excluded original's not", feesInRange(set, "lastmonth", TODAY), 9500);
ok("G7 quarter: all three rows listed", ids(bookingsInRange(set, "quarter", TODAY)), [11, 12, 13]);
ok("G8 quarter: fees count the moved client once", feesInRange(set, "quarter", TODAY), 13500);

// CENTRAL CALENDAR: a booking at 9 PM Central on Aug 31 is 02:00 UTC on Sep 1. It
// belongs to August, whatever time zone the viewer's browser is in.
const aug31 = b({ id: 20, booked_on: "2026-09-01T02:00:00Z" });
ok("H  centralDate converts an instant to its Central day", centralDate("2026-09-01T02:00:00Z"), "2026-08-31");
ok("H2 so Aug 31, 9 PM CT is last month, not this month",
   [ids(bookingsInRange([aug31], "lastmonth", TODAY)), ids(bookingsInRange([aug31], "month", TODAY))], [[20], []]);

// WINDOWS, as of Mon Sep 21 2026. `to` is exclusive.
ok("I  this month", rangeWindow("month", TODAY), { from: "2026-09-01", to: null });
ok("I2 last month is all of August", rangeWindow("lastmonth", TODAY), { from: "2026-08-01", to: "2026-09-01" });
ok("I3 this quarter starts Jul 1", rangeWindow("quarter", TODAY), { from: "2026-07-01", to: null });
ok("I4 YTD starts Jan 1", rangeWindow("ytd", TODAY), { from: "2026-01-01", to: null });
ok("I5 all is unbounded, with nothing to compare", [rangeWindow("all", TODAY), priorWindow("all", TODAY)], [{ from: null, to: null }, null]);

// PRIOR PERIODS: the same point in the period before.
const lab = (r: Parameters<typeof priorWindow>[0], t: string) => { const w = priorWindow(r, t)!; return [w, windowLabel(w, t)]; };
ok("J  this month vs Aug 1-21", lab("month", TODAY), [{ from: "2026-08-01", to: "2026-08-22" }, "Aug 1–21"]);
ok("J2 last month (August) vs all of July", lab("lastmonth", TODAY), [{ from: "2026-07-01", to: "2026-08-01" }, "July"]);
ok("J3 this quarter vs Apr 1-Jun 21", lab("quarter", TODAY), [{ from: "2026-04-01", to: "2026-06-22" }, "Apr 1–Jun 21"]);
ok("J4 YTD vs the same point last year", lab("ytd", TODAY), [{ from: "2025-01-01", to: "2025-09-22" }, "Jan 1–Sep 21, 2025"]);
ok("J5 Mar 31 clamps to the whole of February", lab("month", "2026-03-31"), [{ from: "2026-02-01", to: "2026-03-01" }, "February"]);
ok("J6 January compares with last December, with its year", lab("month", "2026-01-15"), [{ from: "2025-12-01", to: "2025-12-16" }, "Dec 1–15, 2025"]);
ok("J7 the 1st compares with a single day", lab("month", "2026-10-01"), [{ from: "2026-09-01", to: "2026-09-02" }, "Sep 1"]);
ok("J8 quarter clamps too: May 31 vs Feb 1-28", lab("quarter", "2026-05-31"), [{ from: "2026-01-01", to: "2026-03-01" }, "Jan 1–Feb 28"]);

// TOTALS come from the daily series, cut exactly at the window edges.
const day = (period: string, booked: number): TimeseriesRow => ({ period, booked, held: booked, clients: 0, won: 0, won_amount: 0 });
const daily = [day("2026-08-21", 1), day("2026-08-22", 10), day("2026-08-31", 100), day("2026-09-01", 1000), day("2026-09-21", 10000)];
ok("K  this month sums Sep 1 onward", totalsFor(daily, "month", TODAY).booked, 11000);
ok("K2 its comparison stops at Aug 21 inclusive", priorTotalsFor(daily, "month", TODAY).booked, 1);
ok("K3 last month sums all of August and nothing of September", totalsFor(daily, "lastmonth", TODAY).booked, 111);

console.log(`\n${results.filter(r => r === "P").length}/${results.length} passed`);
process.exit(results.includes("F") ? 1 : 0);
