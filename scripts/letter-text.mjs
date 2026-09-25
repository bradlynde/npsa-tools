#!/usr/bin/env node
/*
 * What the client actually reads.
 *
 * Three defects in the letter body, all of which a passing fee-parity run said
 * nothing about, because each lives in the rendered document rather than in the
 * text buildCompBlock returns:
 *
 *   - The Award Implementation reimbursement clause never printed. The wizard
 *     writes "reimbursable" / "not-reimbursable"; the letter tested for
 *     "optionA" / "optionB" and nothing else, so clause 6 vanished with no
 *     error and no gap — the Compensation section simply stopped at 5.
 *   - Two sections numbered IX whenever short notice was on, because the
 *     appended section hard-coded the numeral its template's last section
 *     already carried.
 *   - "$0" on the page: a fee-summary box and a whole Compliance Period Fee
 *     paragraph quoting "a fixed fee of $0". inhPostAwardFee defaults to "0",
 *     so that was the default in-house letter rather than an edge case.
 *
 * Templates are served exactly as the app gets them in production, from
 * templates/*.json. Serving a 404 instead sends the app to its built-in
 * fallback, which is an older contract — see the note in the PR — and would
 * have this file testing a document no client receives.
 *
 *   npx vite --port 5173 &
 *   node scripts/letter-text.mjs
 *
 * Needs playwright-core and a Chromium binary; set CHROME_PATH to override.
 */
import { readFileSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE_URL || "http://localhost:5173";

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.error("playwright-core is not installed — `npm i -D playwright-core`"); process.exit(2); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, !!ok, detail]);

const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

async function open() {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/letters/stats") return json({ total: 0 });
    if (p === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
    if (p.startsWith("/api/templates/")) {
      try {
        return r.fulfill({ status: 200, contentType: "application/json",
          body: readFileSync(`./templates/${p.split("/").pop()}.json`, "utf8") });
      } catch { return r.fulfill({ status: 404, body: "" }); }
    }
    return json({});
  });
  await page.goto(`${BASE}/?view=generator`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  const caption = async () => (await page.locator(".wz-caption").first().textContent()).trim();
  const advanceTo = async (t) => { for (let g = 0; g < 16 && !(await caption()).includes(t); g++) { await page.locator('.wz-btn-primary:has-text("Next")').click(); await page.waitForTimeout(170); } };
  const backTo = async (t) => { for (let g = 0; g < 16 && !(await caption()).includes(t); g++) { await page.locator('.wz-btn:has-text("Back")').click(); await page.waitForTimeout(150); } };
  const paper = async () => (await page.locator(".npsa-paper").first().innerText());
  return { page, caption, advanceTo, backTo, paper };
}

const REIMBURSABLE = "may be eligible for reimbursement through NSGP grant proceeds";
const NOT_REIMBURSABLE = "are not reimbursable through NSGP grant proceeds";

// ── 1. The Award Implementation reimbursement clause ─────────────────────────
{
  const { page, advanceTo, paper } = await open();
  await page.locator('.wz-radio:has-text("Award Implementation") input').first().check();
  await page.waitForTimeout(500);
  await page.locator(".wz-btn-primary").click(); await page.waitForTimeout(400);
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  await advanceTo("Terms");

  const unset = await paper();
  check("unchosen: no reimbursement clause is invented",
    !unset.includes(REIMBURSABLE) && !unset.includes(NOT_REIMBURSABLE));

  await page.locator('.wz-radio:has-text("Reimbursable from grant funds") input').first().check();
  await page.waitForTimeout(500);
  const a = await paper();
  check("reimbursable: clause 6 prints the reimbursable wording", a.includes(REIMBURSABLE));
  check("reimbursable: and not the other one", !a.includes(NOT_REIMBURSABLE));

  await page.locator('.wz-radio:has-text("Not reimbursable") input').first().check();
  await page.waitForTimeout(500);
  const b = await paper();
  check("not reimbursable: clause 6 prints the non-reimbursable wording", b.includes(NOT_REIMBURSABLE));
  check("not reimbursable: and not the other one", !b.includes(REIMBURSABLE));

  await advanceTo("Review");
  const review = await page.locator(".wz-fees").first().innerText();
  check("Review names the clause that will print", /Reimbursement/.test(review) && /clause 6 prints/.test(review),
    review.split("\n").slice(0, 2).join(" "));
  await page.close();
}

// ── 2. Section numbering with short notice on ────────────────────────────────
for (const [label, docLabel] of [["pre-award", "Third Party Grant Writing"], ["in-house", "In-House Grant Writing"]]) {
  const { page, advanceTo, backTo, paper } = await open();
  await page.locator(".wz-btn-primary").click(); await page.waitForTimeout(300);
  if (label === "pre-award") {
    // The two Pre-Award variants are chips under the type picker, not radio cards.
    await backTo("Engagement Type");
    await page.getByRole("button", { name: docLabel }).first().click();
    await page.waitForTimeout(400);
    await page.locator(".wz-btn-primary").click(); await page.waitForTimeout(300);
  }
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  await advanceTo("Terms");
  const notice = page.locator('label:has-text("Short notice"), .wz-check:has-text("Short notice") input, input[type="checkbox"]').first();
  await page.getByText(/Short.notice/i).first().click().catch(() => {});
  await page.waitForTimeout(500);

  const txt = await paper();
  const romans = [...txt.matchAll(/^([IVX]+)\.\s+[A-Z]/gm)].map((m) => m[1]);
  const dupes = romans.filter((r, i) => romans.indexOf(r) !== i);
  check(`${label}: short-notice section is present`, /SHORT-NOTICE APPLICATION CIRCUMSTANCES/i.test(txt));
  check(`${label}: no numeral is used twice`, dupes.length === 0, `saw ${romans.join(",")}`);
  check(`${label}: runs through X`, romans.includes("X"), `saw ${romans.join(",")}`);
  await page.close();
}

// ── 3. No "$0" on a client letter ────────────────────────────────────────────
{
  const { page, advanceTo, backTo, paper } = await open();
  await page.locator(".wz-btn-primary").click(); await page.waitForTimeout(300);
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  await advanceTo("Fees");
  /*
   * Nothing is clicked here on purpose. inhOptPostAwardScope defaults to true
   * and inhPostAwardFee defaults to "0", so this IS the default in-house
   * letter — the $0 block was what a rep got by opening the wizard and
   * touching nothing, not a shape they had to go looking for.
   */
  await page.waitForTimeout(600);

  const zero = await paper();
  check("$0 compliance: no dollar-zero anywhere on the letter", !/\$0\b/.test(zero),
    (zero.match(/.{0,40}\$0\b.{0,40}/) || [""])[0]);
  check("$0 compliance: says the services are included instead",
    /included at no additional fee/i.test(zero));
  check("$0 compliance: drops the clauses that describe paying a fee",
    !/due within thirty \(30\) days of CLIENT'S receipt/i.test(zero));

  // A real fee restores the full block. Scoped by label: the Fees step's input
  // order shifts as options appear, so "the last input" is a different field
  // depending on what is switched on.
  await backTo("Fees");
  // Field labels carry no htmlFor and do not wrap their input, so getByLabel
  // cannot associate them; go through the .wz-field that holds the label.
  await page.locator(".wz-field").filter({ hasText: /Compliance Consulting Fee/i })
    .locator("input.wz-input").fill("2,500");
  await page.waitForTimeout(700);
  const paid = await paper();
  check("real fee: the fixed-fee clause is back", /fixed fee of \$2,500/.test(paid));
  check("real fee: and so are the payment clauses",
    /due within thirty \(30\) days of CLIENT'S receipt/i.test(paid));
  await page.close();
}

await browser.close();
check("no page errors", errors.length === 0, errors.join(" | "));

console.log("");
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad ? 1 : 0);
