#!/usr/bin/env node
/*
 * Pre-call generator check.
 *
 * Covers the two things that were wrong in the briefing Brad sent back, at the
 * level where they were wrong:
 *
 *   1. The booking picker loads, and picking a meeting fills the form from the
 *      booking — including the additional guest, which the old parse path never
 *      looked for.
 *   2. The values sent for generation are the ones the client submitted. The
 *      City Church notes printed a phone number that was not the booked one, so
 *      the request body is asserted against the booking, field by field.
 *
 * Calendly is stubbed in the browser with a payload copied from the real API —
 * including the shapes that broke the first version of the reader: guests on the
 * event rather than the invitee, and a Zoom meeting id wrapped in a union envelope.
 *
 *   npx vite --port 5173 &
 *   node scripts/precall-flow.mjs
 *
 * Needs playwright-core and a Chromium binary; set CHROME_PATH to override.
 */

const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE_URL || "http://localhost:5173";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is not installed — `npm i -D playwright-core`");
  process.exit(2);
}

// Shaped exactly as server/precall-bookings.js returns it.
const BOOKING = {
  eventUri: "https://api.calendly.com/scheduled_events/d14f0255",
  inviteeUri: "https://api.calendly.com/scheduled_events/d14f0255/invitees/993017ba",
  eventName: "NPSA 30 Minute Introduction Zoom Call",
  startTime: "2026-08-12T16:00:00Z",
  endTime: "2026-08-12T16:30:00Z",
  status: "active",
  host: { name: "Brad Lynde", email: "brad@lyndeconsulting.com" },
  facts: {
    orgName: "Greenland Hills UMC",
    orgState: null,
    websiteUrl: null,
    inviteeName: "Geoffrey Moore",
    inviteeEmail: "geoffrey@greenlandhills.org",
    inviteePhone: "2147089835",
    inviteeTimezone: "America/Chicago",
    startTime: "2026-08-12T16:00:00Z",
    guests: ["kevin@meritdallas.com", "raj@meritdallas.com"],
    location: {
      kind: "zoom", label: "Video Web Conference",
      joinUrl: "https://us02web.zoom.us/j/86249830965?pwd=Fesx",
      meetingId: "86249830965", passcode: null,
    },
    questions: [
      { question: "Organization Name", answer: "Greenland Hills UMC" },
      { question: "Contact Phone Number", answer: "2147089835" },
    ],
  },
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let generateBody = null;
const deadlines = [
  { id: 1, state: "IN", program: "federal", cycle_year: 2025, deadline: "2025-10-21",
    kind: "sub_applicant", note: "FY2025 NOFO posted 2025-07-28.", source: "in.gov/dhs",
    confidence: "illustrative" },
  { id: 2, state: "TX", program: "federal", cycle_year: 2026, deadline: "2026-07-06",
    kind: "sub_applicant", note: "5:00pm CT, no extensions.", source: "egrants.gov.texas.gov",
    confidence: "confirmed", layer: "knowledge-base" },
  // One window still open, so the dashboard's "open now" count is exercised rather
  // than only its empty state. Dated far out so the harness does not rot in a month.
  { id: 3, state: "PA", program: "PA-NSGFP", cycle_year: 2099, deadline: "2099-09-10",
    kind: "state_program", note: "OPEN NOW.", source: "pa.gov/agencies/pccd",
    confidence: "confirmed", layer: "verified" },
];

await page.route(/\/api\//, async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (path === "/api/precall/bookings") return json({ bookings: [BOOKING], cached: false });
  if (path === "/api/precall/deadlines") {
    if (req.method() === "PUT") {
      const row = JSON.parse(req.postData() || "{}");
      deadlines.push({ id: deadlines.length + 1, ...row, cycle_year: row.cycleYear });
      return json({ ok: true, id: deadlines.length });
    }
    return json({ deadlines });
  }
  if (path === "/api/precall") {
    generateBody = JSON.parse(req.postData() || "{}");
    return json({ notes: "# Generated\n\n## Meeting Details\n- ok", website: null, websiteFetched: false });
  }
  if (path === "/api/letters/stats") return json({ total: 0 });
  if (path === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
  return json({});
});

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

await page.goto(`${BASE}/?view=precall`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// ── 1. the picker renders the booking ────────────────────────────────────
const row = page.locator('button:has-text("Greenland Hills UMC")').first();
check("booking appears in the picker", (await row.count()) > 0);

const guestBadge = await page.locator("text=/\\+2 guests/").count();
check("guests are visible before generating", guestBadge > 0);

// ── 2. picking it fills the form ─────────────────────────────────────────
await row.click();
await page.waitForTimeout(400);

const valueOf = async (placeholder) =>
  page.locator(`input[placeholder="${placeholder}"]`).first().inputValue();

check("org name filled", (await valueOf("e.g. iThrive Christian Church")) === "Greenland Hills UMC");
check("phone filled verbatim from the booking",
  (await valueOf("404-555-0000")) === "2147089835",
  await valueOf("404-555-0000"));
check("zoom id unwrapped, not [object Object]",
  (await valueOf("815-052-42724")) === "86249830965",
  await valueOf("815-052-42724"));

const emailInputs = await page.locator('input[placeholder="email@org.org"]').all();
const emails = await Promise.all(emailInputs.map((i) => i.inputValue()));
check("primary contact + both guests became attendee rows",
  emails.length === 3 && emails.includes("kevin@meritdallas.com") && emails.includes("raj@meritdallas.com"),
  emails.join(", "));

// ── 3. generation sends the booking, not just the typed form ─────────────
await page.locator('button:has-text("Generate Pre-Call Notes")').click();
await page.waitForTimeout(900);

check("generate sends the eventUri so the server re-reads the booking",
  generateBody?.eventUri === BOOKING.eventUri, JSON.stringify(generateBody?.eventUri));
check("submitted phone survives to the request body",
  generateBody?.formData?.attendees?.[0]?.phone === "2147089835",
  JSON.stringify(generateBody?.formData?.attendees?.[0]));

// ── 4. the deadline editor opens and lists curated rows ──────────────────
await page.locator('button:has-text("Deadlines")').first().click();
await page.waitForTimeout(500);
check("deadline editor lists the curated row",
  (await page.locator("text=2025-10-21").count()) > 0);
check("deadline source is shown so it can be re-checked",
  (await page.locator("text=in.gov/dhs").count()) > 0);
check("a date needing checking is labelled, not shown as confirmed",
  (await page.locator('text="verify"').count()) > 0 && (await page.locator('text="confirmed"').count()) > 0);

// ── 5. the deadlines are reachable from the dashboard, not only from in here ──
// A rep wants to know whether anything is open before they have a call booked, so
// the box has to be one click from the toolbox landing page.
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const strip = page.locator('div:has-text("NSGP Deadlines")').last();
check("deadlines are surfaced on the dashboard", (await strip.count()) > 0);
check("the dashboard says how many windows are open now",
  (await page.locator("text=/1 open now/").count()) > 0,
  await page.locator('text=/open now|none open/').first().textContent().catch(() => "not found"));

await page.locator('text="NSGP Deadlines"').last().click();
await page.waitForTimeout(600);
check("clicking it opens the editor over the dashboard",
  (await page.locator("text=2099-09-10").count()) > 0);
check("a web-checked row says so, so its provenance is visible",
  (await page.locator('text="web-checked"').count()) > 0);

await browser.close();

check("no uncaught page errors", errors.length === 0, errors.join(" | "));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
