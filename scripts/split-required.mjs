#!/usr/bin/env node
/*
 * The split is required, not suggested.
 *
 * scripts/split-letters.mjs proves the arithmetic of a split. This proves the
 * gate in front of it. Stuart: "if the split letter notification pops up then we
 * need the rep to be required to create the split before they can save or
 * print."
 *
 * A contingent letter carrying two applications describes an engagement NPSA
 * will not sign, so while the notice is up neither Save nor Download is
 * available and nothing reaches the letters API. Taking the split clears it.
 *
 * The database is stubbed inside the browser, so this runs without one, and
 * every write is logged — a gate that merely greys out a button while the
 * click still saves would pass on looks and fail here.
 *
 *   npx vite --port 5173 &
 *   node scripts/split-required.mjs
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

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// A blocked print must not open a print window either; record any that appear.
const popups = [];
page.on("popup", (p) => popups.push(p.url()));

// Alerts are the backstop the disabled buttons sit in front of.
const alerts = [];
page.on("dialog", (d) => { alerts.push(d.message()); d.dismiss(); });

// ── stand-in database ────────────────────────────────────────────────────
const db = new Map();
const writes = [];
let seq = 0;

await page.route(/\/api\//, async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const json = (body) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  if (path === "/api/letters/stats") return json({ total: db.size });
  if (path === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
  if (path.startsWith("/api/templates/")) return route.fulfill({ status: 404, body: "" });

  if (path === "/api/letters" && method === "POST") {
    const rec = { ...JSON.parse(req.postData() || "{}"), id: ++seq };
    db.set(rec.id, rec);
    writes.push(`POST #${rec.id}`);
    return json(rec);
  }
  if (path === "/api/letters") return json([...db.values()]);

  const match = path.match(/^\/api\/letters\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === "GET") return json(db.get(id));
    if (method === "PUT") {
      writes.push(`PUT #${id}`);
      db.set(id, { ...db.get(id), ...JSON.parse(req.postData() || "{}"), id });
      return json(db.get(id));
    }
  }
  return json({});
});

// ── helpers ──────────────────────────────────────────────────────────────
const caption = async () => (await page.locator(".wz-caption").first().textContent()).trim();
const saveButton = () =>
  page.locator('.wz-btn:has-text("Save"), .wz-btn:has-text("Update")').first();
const downloadButton = () =>
  page.locator('.wz-btn-primary:has-text("Download"), .wz-btn-primary:has-text("Print")').first();

const advanceTo = async (title) => {
  for (let guard = 0; guard < 12 && !(await caption()).includes(title); guard++) {
    await page.locator('.wz-btn-primary:has-text("Next")').click();
    await page.waitForTimeout(200);
  }
};
const backTo = async (title) => {
  for (let guard = 0; guard < 12 && !(await caption()).includes(title); guard++) {
    await page.locator('.wz-btn:has-text("Back")').click();
    await page.waitForTimeout(160);
  }
};

// ── run ──────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/?view=generator`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.locator(".wz-btn-primary").click();   // past the document picker
await page.waitForTimeout(300);
await page.locator(".wz-input").first().fill("Shelter Cove Community Church");

// A contingent engagement, so the one-per-application rule applies.
await advanceTo("Fees");
await page.locator('.wz-radio:has-text("Partial Contingency") input').first().check();
await page.waitForTimeout(300);

// The download carries its own guard on the expiration date. Satisfy it, so a
// disabled button in this run can only mean the split.
await advanceTo("Terms");
await page.locator('.wz-input[type="date"]').last().fill("2026-12-31");
await page.waitForTimeout(300);

// One application: nothing to split, everything available.
await advanceTo("Review");
const oneAppSave = await saveButton().isDisabled();
const oneAppDownload = await downloadButton().isDisabled();

// Add a second program — one campus, two applications.
await backTo("Scope");
await page.locator('.wz-chip-add').first().click();
await page.waitForTimeout(400);
const noticeSaysBlocked =
  await page.locator("text=/cannot be saved or downloaded until it is split/i").count() > 0;

await advanceTo("Review");
const blockedSave = await saveButton().isDisabled();
const blockedDownload = await downloadButton().isDisabled();

// Clicking anyway must do nothing at all — no write, no print window, no modal.
// (React refuses to deliver a click to a control its own props mark disabled,
// so the alert() inside handlePrint and saveLetter cannot be reached from here.
// Those guards are the backstop for callers that never pass through these two
// buttons; what a rep meets is the disabled button and the reason on it.)
// Wrapped, because when the gate is missing the first click opens the save
// modal and the modal then swallows the second — a failure to report, not to
// crash on.
const clickAnyway = async (button) => {
  try {
    await button().click({ force: true, timeout: 3000 });
  } catch {
    /* something is in the way; the checks below say what happened */
  }
  await page.waitForTimeout(400);
};
await clickAnyway(downloadButton);
await clickAnyway(saveButton);
// If the gate is missing, one of those clicks opened the save modal. Close it,
// so the rest of the run reports the failure instead of timing out behind it.
const cancel = page.locator('button:has-text("Cancel")').last();
if (await cancel.count()) { await cancel.click().catch(() => {}); await page.waitForTimeout(300); }

const blockedHint = (await saveButton().getAttribute("title")) || "";
const blockedDownloadHint = (await downloadButton().getAttribute("title")) || ""; 
const writesWhileBlocked = writes.length;
const modalOpened = await page.locator('text=/Save Letter|Update Letter/').count() > 2;

// Take the split the notice offers.
await backTo("Scope");
await page.locator('button:has-text("Split into")').first().click();
await page.waitForTimeout(500);
const rep = page.locator("select").last();
if (await rep.count()) {
  try { await rep.selectOption({ label: "Chad Burgess" }); } catch { /* already selected */ }
}
await page.waitForTimeout(200);
await page.locator('button:has-text("Save 2 Letters")').last().click();
await page.waitForTimeout(1000);

await advanceTo("Review");
const freedSave = await saveButton().isDisabled();
const freedDownload = await downloadButton().isDisabled();

await browser.close();

const checks = [
  ["one application: Save is available", oneAppSave === false],
  ["one application: Download is available", oneAppDownload === false],
  ["two applications: the notice says the letter cannot be saved or downloaded",
    noticeSaysBlocked],
  ["two applications: Save is disabled", blockedSave === true],
  ["two applications: Download is disabled", blockedDownload === true],
  ["a forced click writes nothing to the letters API", writesWhileBlocked === 0],
  ["a forced click opens no print window", popups.length === 0],
  ["a forced click does not open the save modal", modalOpened === false],
  ["a blocked Save says why it is blocked", /one per application/i.test(blockedHint)],
  ["so does a blocked Download", /one per application/i.test(blockedDownloadHint)],
  ["no stray alert interrupts the rep", alerts.length === 0],
  ["after the split: two letters are saved", db.size === 2],
  ["after the split: Save is available again", freedSave === false],
  ["after the split: Download is available again", freedDownload === false],
  ["no page errors", errors.length === 0],
];

console.log("\nwrites: " + (writes.join(", ") || "(none)"));
console.log("alerts: " + (alerts.join(" | ") || "(none)") + "\n");
for (const [name, ok] of checks) console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
if (errors.length) console.log("\npage errors:\n  " + errors.join("\n  "));

const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad ? 1 : 0);
