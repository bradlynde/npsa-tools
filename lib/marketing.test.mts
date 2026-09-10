import { bookingsInRange, campaignsInRange, channelsInRange, creditedOn, feesInRange, type BookingRow } from "./marketing.ts";

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
// moved. A replacement row's own booked_on is the day of the reschedule, so a
// meeting set 45 days ago and moved 5 days ago must NOT land in a 30-day window --
// upstream's tiles and chart already date it from its origin, and these panels sit
// right under them. Relative dates, because rangeStart() reads the clock.
const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
const old = new Date(Date.now() - 45 * 86_400_000).toISOString();

ok("F  creditedOn uses the origin when there is one",
   creditedOn(b({ booked_on: recent, originated_on: old })), old);
ok("F2 and booked_on when the row replaced nothing",
   creditedOn(b({ booked_on: recent, originated_on: null })), recent);
ok("F3 and booked_on from a backend that does not send the field yet",
   creditedOn(b({ booked_on: recent })), recent);

const moved = b({ id: 11, booked_on: recent, originated_on: old, became_client: true, fee: 9500 });
const fresh = b({ id: 12, booked_on: recent, became_client: true, fee: 4000 });
const original = b({ id: 13, booked_on: old, exclusion_reason: "rescheduled", cancelled: true });
const set = [moved, fresh, original];
const ids = (r: BookingRow[]) => r.map(x => x.id).sort((x, y) => x - y);
const booked = (r: { booked: number }[]) => r.reduce((n, x) => n + x.booked, 0);

ok("G  30d list holds the new booking, not the move or its original",
   ids(bookingsInRange(set, "30d")), [12]);
ok("G2 30d channel table counts one booking", booked(channelsInRange(set, "30d")), 1);
ok("G3 30d campaign table counts one booking", booked(campaignsInRange(set, "30d")), 1);
ok("G4 30d fees leave out the moved client's fee", feesInRange(set, "30d"), 4000);
ok("G5 90d list holds all three rows", ids(bookingsInRange(set, "90d")), [11, 12, 13]);
ok("G6 90d fees count the moved client once, the original not at all",
   feesInRange(set, "90d"), 13500);

console.log(`\n${results.filter(r => r === "P").length}/${results.length} passed`);
process.exit(results.includes("F") ? 1 : 0);
