#!/usr/bin/env node
/*
 * Is the letter the same when /api/templates doesn't answer?
 *
 * Every letter paints first from the built-in templates in
 * src/generator/templates.js and swaps to the server's once /api/templates
 * answers. If that call fails — and since #266 an expired login gets a 401 — the
 * built-in copy is what the rep drafts, with nothing on screen to say so. That
 * copy was kept by hand and the post-award one had fallen a contract behind: no
 * Effective Date, milestone rather than dated payments, and no reimbursement
 * clause at all.
 *
 * So each document type is rendered twice with the same inputs, once with the
 * templates served and once with the call refused, and the two pages must read
 * the same word for word.
 *
 *   npx vite --port 5173 &
 *   node scripts/template-fallback.mjs
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

const TYPES = [
  { key: "pre-award", name: "Grace Fellowship" },
  { key: "in-house", chip: "In-House Grant Writing", name: "Grace Fellowship" },
  { key: "post-award", radio: "Award Implementation", name: "Grace Fellowship",
    reimbursable: true, effective: "2026-10-01" },
  { key: "addendum", radio: "Addendum", name: "Grace Fellowship" },
];

async function render(t, served) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => errors.push(e.message));
  let templateCalls = 0;
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p.startsWith("/api/templates/")) {
      templateCalls++;
      if (!served) return r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Sign in again"}' });
      return r.fulfill({ status: 200, contentType: "application/json",
        body: readFileSync(`./templates/${p.split("/").pop()}.json`, "utf8") });
    }
    if (p === "/api/letters/stats") return json({ total: 0 });
    return json({});
  });
  await page.goto(`${BASE}/?view=generator`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  const caption = async () => (await page.locator(".wz-caption").first().textContent()).trim();
  const next = async () => { await page.locator('.wz-btn-primary:has-text("Next")').click(); await page.waitForTimeout(170); };
  if (t.radio) { await page.locator(`.wz-radio:has-text("${t.radio}") input`).first().check(); await page.waitForTimeout(400); }
  if (t.chip) { await page.getByRole("button", { name: t.chip }).first().click(); await page.waitForTimeout(400); }
  for (let g = 0; g < 16 && !(await caption()).includes("Client"); g++) await next();
  await page.locator(".wz-input").first().fill(t.name);
  for (let g = 0; g < 16 && !(await caption()).includes("Review"); g++) {
    const field = (label) => page.locator(".wz-field").filter({ hasText: label }).locator("input").first();
    if (await field("Offer Expiration Date").count()) await field("Offer Expiration Date").fill("2026-12-31");
    if (t.effective) {
      const eff = page.locator(".wz-field").filter({ hasText: "Effective Date" }).filter({ hasNotText: "Offer Expiration" }).locator("input").first();
      if (await eff.count()) await eff.fill(t.effective);
    }
    if (t.reimbursable) {
      const radio = page.locator('.wz-radio:has-text("Reimbursable from grant funds") input').first();
      if (await radio.count()) await radio.check();
    }
    await next();
  }
  await page.waitForTimeout(300);
  // The date stamped at the top is today's in both runs; nothing else may differ.
  const text = await page.locator(".npsa-paper").first().innerText();
  await page.close();
  return { text, templateCalls };
}

for (const t of TYPES) {
  const served = await render(t, true);
  const refused = await render(t, false);
  check(`${t.key}: the refused run really did go without the server's templates`,
    refused.templateCalls > 0, `${refused.templateCalls} template calls`);
  const same = served.text === refused.text;
  let where = "";
  if (!same) {
    const a = served.text.split("\n"), b = refused.text.split("\n");
    const i = a.findIndex((line, k) => line !== b[k]);
    where = `first difference at line ${i + 1}: served "${(a[i] || "").slice(0, 70)}" vs fallback "${(b[i] || "").slice(0, 70)}"`;
  }
  check(`${t.key}: the letter reads the same without them, word for word`, same, where);
  if (t.key === "post-award") {
    check("post-award: and the fallback letter still carries the reimbursement clause",
      /may be eligible for reimbursement through NSGP grant proceeds/.test(refused.text));
  }
}

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
const failed = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
