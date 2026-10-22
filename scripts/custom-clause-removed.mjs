#!/usr/bin/env node
/*
 * The custom clause is gone.
 *
 * The Terms step had an "Additional Clause" box behind a "Custom clause"
 * disclosure. It saved to customClause / inhCustomClause / postCustomClause,
 * but the letter printed polishedClause, which only the "Polish with AI"
 * button filled, and that button went away in the wizard rebuild (#105). So
 * anything typed in the box never reached a letter. Removed rather than
 * repaired: nobody used it.
 *
 *   A. No document type's Terms step offers the box any more.
 *   B. A saved letter that still carries an old polished clause does not
 *      print it. None of the 191 saved letters had one (checked 2026-10-22);
 *      this pins that the field is ignored, not just empty.
 *
 *   npx vite --port 5173 &
 *   node scripts/custom-clause-removed.mjs
 *
 * Needs playwright-core and a Chromium binary; set CHROME_PATH to override.
 */
import { readFileSync } from "node:fs";
import { defaultForm } from "../src/generator/defaults.js";

const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE_URL || "http://localhost:5173";

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.error("playwright-core is not installed — `npm i -D playwright-core`"); process.exit(2); }

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, !!ok, detail]);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const OLD = "OLD POLISHED CLAUSE FROM BEFORE THE WIZARD";
const SAVED = [
  { id: 1, doc_tab: "pre", key: "polishedClause" },
  { id: 2, doc_tab: "inh", key: "inhPolishedClause" },
  { id: 3, doc_tab: "post", key: "postPolishedClause" },
].map((l) => ({
  id: l.id, doc_tab: l.doc_tab, client_name: `Grace Fellowship ${l.doc_tab}`, rep_name: "Chad",
  total_fee: 0, updated_at: "2026-07-01T12:00:00Z", saved_html: null,
  form_data: { ...defaultForm, clientName: `Grace Fellowship ${l.doc_tab}`, [l.key]: OLD,
               customClause: OLD, inhCustomClause: OLD, postCustomClause: OLD },
}));

async function open(view = "generator") {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/letters/stats") return json({ total: SAVED.length });
    if (p === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
    if (p === "/api/letters") return json(SAVED.map(({ form_data, ...l }) => l));
    const m = p.match(/^\/api\/letters\/(\d+)$/);
    if (m) return json(SAVED.find((l) => l.id === Number(m[1])) || {});
    if (p.startsWith("/api/templates/")) {
      try {
        return r.fulfill({ status: 200, contentType: "application/json",
          body: readFileSync(`./templates/${p.split("/").pop()}.json`, "utf8") });
      } catch { return r.fulfill({ status: 404, body: "" }); }
    }
    return json({});
  });
  await page.goto(`${BASE}/?view=${view}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const caption = async () => (await page.locator(".wz-caption").first().textContent()).trim();
  const advanceTo = async (t) => {
    for (let g = 0; g < 16 && !(await caption()).includes(t); g++) {
      await page.locator('.wz-btn-primary:has-text("Next")').click();
      await page.waitForTimeout(170);
    }
  };
  return { page, caption, advanceTo };
}

const paperText = (page) => page.evaluate(() => document.querySelector(".npsa-paper")?.innerText || "");

// ── A. No Terms step offers the clause ──────────────────────────────────────
// Each case names what its own letter says, so a click that missed — leaving the
// wizard on its default document — fails here instead of passing as in-house.
for (const [label, type, variant, marker] of [
  ["in-house", "Pre-Award", "In-House Grant Writing", /in-house/i],
  ["third-party", "Pre-Award", "Third Party Grant Writing", /third-party grant writer/i],
  ["award implementation", "Award Implementation", null, /Award Implementation/],
  ["addendum", "Addendum", null, /Addendum to Engagement Letter/i],
]) {
  const { page, caption, advanceTo } = await open();
  await page.getByText(type, { exact: true }).first().click();
  await page.waitForTimeout(300);
  if (variant) { await page.getByRole("button", { name: variant }).first().click(); await page.waitForTimeout(300); }
  await advanceTo("Terms");
  check(`${label}: the wizard is on that document`, marker.test(await paperText(page)));
  const onTerms = (await caption()).includes("Terms");
  const panel = await page.evaluate(() => document.body.innerText);
  check(`${label}: reached the Terms step`, onTerms, await caption());
  check(`${label}: Terms has no "Custom clause" or "Additional Clause"`,
    onTerms && !/Custom clause|Additional Clause/i.test(panel));
  check(`${label}: Terms still has the NPSA signer`, /NPSA Signer/i.test(panel));
  await page.close();
}

// ── B. An old saved clause is not printed ───────────────────────────────────
for (const l of SAVED) {
  const { page } = await open("letters");
  const row = page.locator("tr", { hasText: l.client_name });
  await row.getByRole("button", { name: "Load" }).click();
  await page.waitForTimeout(1200);
  const text = await paperText(page);
  check(`${l.doc_tab}: the saved letter opens and renders`, text.includes(l.client_name), text.slice(0, 80));
  check(`${l.doc_tab}: it does not print the old clause`, !text.includes(OLD));
  check(`${l.doc_tab}: nor an "Additional Terms" box`, !/Additional Terms/i.test(text));
  await page.close();
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();

for (const [name, ok, detail] of checks)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n        ${detail}` : ""}`);
const passed = checks.filter((c) => c[1]).length;
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
