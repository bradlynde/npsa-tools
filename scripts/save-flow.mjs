#!/usr/bin/env node
/*
 * Save-flow check for the generator wizard.
 *
 * Exercises the branch that used to destroy data: a rep saves a Pre-Award
 * letter, switches engagement type, and saves again. That must create a SECOND
 * letter (POST), never overwrite the first (PUT) — an Award Implementation
 * letter is another contract for the same client, not a revision of their
 * pre-award one. It also checks the opposite case, that saving twice without
 * switching still updates in place.
 *
 * The database is stubbed inside the browser, so this runs without one. What it
 * verifies is the client-side decision — POST vs PUT — which is where the bug
 * lived. Re-run it against the real API once that is up.
 *
 *   npx vite --port 5173 &
 *   node scripts/save-flow.mjs
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

// ── stand-in database ────────────────────────────────────────────────────
const db = new Map();
const log = [];
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
    log.push(`POST -> created #${rec.id} (${rec.doc_tab})`);
    return json(rec);
  }
  if (path === "/api/letters") return json([...db.values()]);

  const match = path.match(/^\/api\/letters\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === "GET") return json(db.get(id));
    if (method === "PUT") {
      log.push(`PUT -> overwrote #${id}`);
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
const save = async () => {
  await saveButton().click();
  await page.waitForTimeout(400);
  const rep = page.locator("select").last();
  if (await rep.count()) {
    try {
      await rep.selectOption({ label: "Chad Burgess" });
    } catch {
      /* already selected */
    }
  }
  await page.waitForTimeout(150);
  // The modal names the party it is about to file the document under. It said
  // "Client:" for every document type, including one addressed to a recipient.
  gwSaveModalLabel = await page.getByText(/^(Client|Recipient):/).first()
    .innerText().catch(() => "");
  await page.locator('button:has-text("Save"), button:has-text("Update")').last().click();
  await page.waitForTimeout(800);
};
let gwSaveModalLabel = "";

// ── run ──────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/?view=generator`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.locator(".wz-btn-primary").click();
await page.waitForTimeout(300);
await page.locator(".wz-input").first().fill("Beth Shalom Synagogue");

await advanceTo("Review");
await save();
const labelAfterFirst = (await saveButton().textContent()).trim();

// Same letter, edited — must update in place.
await backTo("Client");
await page.locator(".wz-input").first().fill("Beth Shalom Synagogue (Downtown)");
await advanceTo("Review");
await save();
const updatedInPlace = log.some((l) => l.startsWith("PUT"));

// Different engagement type — must fork.
await backTo("Engagement Type");
await page.locator('.wz-radio:has-text("Award Implementation") input').check();
await page.waitForTimeout(400);
// The save button lives on the Review step, so read its label from there.
await advanceTo("Review");
const labelAfterSwitch = (await saveButton().textContent()).trim();
await save();
const lettersAfterFork = db.size;

/*
 * An addendum and a grant writer agreement each keep their party under their
 * own key, and every save path read form.clientName. So an addendum filed
 * itself as "Untitled", and a grant-writer agreement filed itself under
 * whichever pre-award client the rep had open before it — a name belonging to
 * someone else. The Review step already knew better; now one helper answers for
 * all of them.
 */
await backTo("Engagement Type");
await page.locator('.wz-radio:has-text("Addendum") input').check();
await page.waitForTimeout(500);
// Advance off the type picker first — its step carries no inputs, so filling
// "the first .wz-input" here waits forever for a field on the next screen.
await advanceTo("Client");
await page.locator(".wz-input").first().fill("Temple Emanuel");
await advanceTo("Review");
await save();
const addendumRow = [...db.values()].find((l) => l.doc_tab === "addendum");

await backTo("Engagement Type");
await page.locator('.wz-radio:has-text("3rd Party Grant Writer") input').check();
await page.waitForTimeout(500);
await advanceTo("Grant Writer");
await page.locator(".wz-input").first().fill("Cardinal Grants LLC");
await advanceTo("Review");
// The download is the other half of this PR: the gw form has no expiration
// field, so the expiration guard could never be satisfied here and the button
// stayed dead for the life of the document.
const gwDownload = page.locator('.wz-btn-primary:has-text("Download"), .wz-btn-primary:has-text("Print")').first();
const gwDownloadDisabled = await gwDownload.isDisabled();
const gwBlockerShown = await page.locator("text=/things? to fix first/").count() > 0;
await save();
const gwRow = [...db.values()].find((l) => l.doc_tab === "gw");
const gwModalLabel = gwSaveModalLabel;

await browser.close();

const tabs = [...db.values()].map((l) => l.doc_tab);
const checks = [
  ["first save creates a letter", log[0]?.startsWith("POST")],
  ["button reads Update once saved", labelAfterFirst === "Update Letter"],
  ["editing updates in place", updatedInPlace],
  ["button reverts to Save after switching type", labelAfterSwitch === "Save Letter"],
  ["switching type creates a second letter", lettersAfterFork === 2, lettersAfterFork],
  ["both documents survive", tabs.includes("inh") && tabs.includes("post")],
  ["an addendum saves under its own party, not Untitled",
    addendumRow?.client_name === "Temple Emanuel", addendumRow?.client_name],
  ["a grant writer agreement saves under its recipient",
    gwRow?.client_name === "Cardinal Grants LLC", gwRow?.client_name],
  ["and never under a pre-award client it is not addressed to",
    !/Beth Shalom/.test(String(gwRow?.client_name || "")), gwRow?.client_name],
  ["the save modal names the recipient, not a client", /Recipient/.test(gwModalLabel)],
  ["a grant writer agreement can be downloaded", gwDownloadDisabled === false],
  ["and shows no blocker pointing at a step it does not have", gwBlockerShown === false],
  ["no page errors", errors.length === 0],
];

console.log("\n" + log.join("\n"));
console.log("letters: " + [...db.values()].map((l) => `#${l.id} ${l.doc_tab}`).join(", ") + "\n");
for (const [name, ok, detail] of checks) console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`);
if (errors.length) console.log("\npage errors:\n  " + errors.join("\n  "));

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
