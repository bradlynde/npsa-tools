#!/usr/bin/env node
/*
 * The two layout nits from the letter audit, and the proofreading aid.
 *
 *   - Guarantees spacing. A state program's "no NOFO" guarantee was joined in
 *     with blank lines, so the moment a letter carried a state program the
 *     Guarantees list gained a gap after that item and nowhere else.
 *   - Item 10 onward. The hanging indent widened for a two-digit number, so in
 *     a list that reaches 10 — the Compliance Period scope runs to 14 — the text
 *     of 10+ sat 8px right of 1-9.
 *   - Unfilled placeholders ("[CLIENT NAME]", "[Address TBD]") are highlighted
 *     on the preview and print as plain text, as they always have.
 *
 * All measured on the rendered paper, since each is a relationship between
 * rows rather than a property of any one of them.
 *
 *   npx vite --port 5173 &
 *   node scripts/letter-layout.mjs
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
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/letters/stats") return json({ total: 0 });
    if (p === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
    if (p === "/api/letters" && r.request().method() === "POST") return json({ id: 1 });
    if (p.startsWith("/api/templates/")) {
      // As production serves them; a 404 would test the built-in fallback.
      try {
        return r.fulfill({ status: 200, contentType: "application/json",
          body: readFileSync(`./templates/${p.split("/").pop()}.json`, "utf8") });
      } catch { return r.fulfill({ status: 404, body: "" }); }
    }
    return json({});
  });
  await page.goto(`${BASE}/?view=generator`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const caption = async () => (await page.locator(".wz-caption").first().textContent()).trim();
  const advanceTo = async (t) => { for (let g = 0; g < 16 && !(await caption()).includes(t); g++) { await page.locator('.wz-btn-primary:has-text("Next")').click(); await page.waitForTimeout(170); } };
  return { page, caption, advanceTo };
}

// Rows of the list under a numbered section heading, up to the next heading.
const LIST = (title) => {
  const paper = document.querySelector(".npsa-paper");
  const h = [...paper.querySelectorAll("div")]
    .find((d) => !d.children.length && /^[IVX]+\./.test(d.textContent.trim()) && d.textContent.includes(title));
  if (!h) return null;
  const rows = [];
  for (let n = h.nextElementSibling; n && !/^[IVX]+\.\s/.test(n.textContent.trim()); n = n.nextElementSibling) {
    for (const r of n.querySelectorAll(":scope > div")) {
      const spans = r.querySelectorAll(":scope > span");
      const b = r.getBoundingClientRect();
      rows.push({
        text: r.textContent.trim().slice(0, 40),
        top: b.top, bottom: b.bottom,
        textX: spans[1] ? Math.round(spans[1].getBoundingClientRect().left) : null,
        prefixFits: spans[0] ? spans[0].scrollWidth <= spans[0].offsetWidth + 0.5 : true,
      });
    }
  }
  return rows;
};

// ── 1. Guarantees spacing with a state program ───────────────────────────────
for (const [key, chip] of [["pre", null], ["inh", "In-House Grant Writing"]]) {
  const { page, advanceTo } = await open();
  if (chip) { await page.getByRole("button", { name: chip }).first().click(); await page.waitForTimeout(400); }
  await advanceTo("Client");
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  await advanceTo("Scope");
  await page.locator(".wz-chip-add").first().click();          // a second, state, program
  await page.waitForTimeout(450);

  const rows = await page.evaluate(LIST, "Guarantees of NPSA");
  const items = (rows || []).filter((r) => /^\d+\.\s/.test(r.text));
  const blanks = (rows || []).filter((r) => r.text === "");
  check(`${key}: the Guarantees list carries the state program's guarantee`,
    items.some((r) => /state government/.test(r.text)) || items.length >= 6,
    items.map((r) => r.text.slice(0, 3)).join(" "));
  check(`${key}: and no blank line opens up inside it`, blanks.length === 0,
    `${blanks.length} blank row(s) among ${rows?.length} rows`);
  const gaps = items.slice(1).map((r, i) => Math.round(r.top - items[i].bottom));
  check(`${key}: every Guarantee sits the same distance from the one before`,
    gaps.length > 0 && new Set(gaps).size === 1, `gaps ${gaps.join(", ")}px`);
  await page.close();
}

// ── 2. Item 10 onward lines up with 1-9 ──────────────────────────────────────
{
  const { page, advanceTo } = await open();
  await advanceTo("Client");
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  const rows = await page.evaluate(LIST, "Scope of Work");
  const top = (rows || []).filter((r) => /^\d+\.\s/.test(r.text) && r.textX !== null);
  const single = top.filter((r) => /^\d\.\s/.test(r.text));
  const double = top.filter((r) => /^\d\d\.\s/.test(r.text));
  check("a list in the letter reaches item 10", double.length > 0, `${top.length} numbered rows`);
  const xs = new Set(single.map((r) => r.textX));
  const xd = new Set(double.map((r) => r.textX));
  check("item 10 onward starts its text where items 1-9 do",
    xd.size === 1 && xs.has([...xd][0]),
    `1-9 at ${[...xs].join("/")}px, 10+ at ${[...xd].join("/")}px`);
  check("and \"10.\" fits the number column without spilling into the text",
    double.every((r) => r.prefixFits), double.filter((r) => !r.prefixFits).map((r) => r.text.slice(0, 4)).join(", "));
  await page.close();
}

// ── 3. Unfilled placeholders: marked on screen, plain in print ───────────────
const MARKS = () => [...document.querySelectorAll(".npsa-paper mark.npsa-unresolved")]
  .map((m) => ({ text: m.textContent, bg: getComputedStyle(m).backgroundColor }));
const PAINTS = (bg) => { const m = bg.match(/[\d.]+/g); return !!m && (m.length < 4 || Number(m[3]) > 0); };
{
  const { page, advanceTo } = await open();
  // Client name left blank on purpose.
  await advanceTo("Terms");
  const exp = page.locator(".wz-field").filter({ hasText: "Offer Expiration Date" }).locator("input").first();
  if (await exp.count()) await exp.fill("2026-12-31");
  await advanceTo("Review");

  const marks = await page.evaluate(MARKS);
  check("an unfilled [CLIENT NAME] is highlighted on the preview",
    marks.some((m) => m.text === "[CLIENT NAME]" && PAINTS(m.bg)), JSON.stringify(marks.slice(0, 3)));
  check("so is an unfilled [Address TBD]",
    marks.some((m) => m.text === "[Address TBD]" && PAINTS(m.bg)));

  const wait = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
  await page.locator(".wz-btn").filter({ hasText: /Download/ }).first().click();
  await page.waitForTimeout(400);
  let pop = await wait;
  if (!pop) {
    const again = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    const rep = page.locator("select").last();
    if (await rep.count()) await rep.selectOption({ label: "Chad Burgess" }).catch(() => {});
    await page.locator('button:has-text("Save"), button:has-text("Update")').last().click();
    pop = await again;
  }
  check("the letter still downloads with a placeholder in it", !!pop);
  if (pop) {
    await pop.waitForTimeout(600);
    const printed = await pop.evaluate(() => [...document.querySelectorAll("mark.npsa-unresolved")]
      .map((m) => ({ text: m.textContent, bg: getComputedStyle(m).backgroundColor, color: getComputedStyle(m).color,
        parent: getComputedStyle(m.parentElement).color })));
    check("in the print window it is plain text: no highlight",
      printed.length > 0 && printed.every((m) => !PAINTS(m.bg)), JSON.stringify(printed[0]));
    check("and the same ink as the words around it",
      printed.length > 0 && printed.every((m) => m.color === m.parent), JSON.stringify(printed[0]));
    await pop.close();
  }

  // Fill the name and the address, and nothing should be marked any more.
  await page.locator('.wz-btn:has-text("Back")').click();
  for (let g = 0; g < 8 && !(await (await page.locator(".wz-caption").first().textContent()).includes("Client")); g++) {
    await page.locator('.wz-btn:has-text("Back")').click(); await page.waitForTimeout(150);
  }
  await page.locator(".wz-input").first().fill("Grace Fellowship");
  await page.waitForTimeout(300);
  const left = (await page.evaluate(MARKS)).map((m) => m.text);
  check("once the client is named, [CLIENT NAME] is no longer marked", !left.includes("[CLIENT NAME]"), left.join(", "));
  await page.close();
}

// The grant writer form's checked boxes print "[X]" — a mark, not a placeholder.
{
  const { page, advanceTo } = await open();
  await page.locator('.wz-radio:has-text("3rd Party Grant Writer") input').first().check();
  await page.waitForTimeout(450);
  await advanceTo("Review");
  const text = await page.locator(".npsa-paper").first().innerText();
  const marked = (await page.evaluate(MARKS)).map((m) => m.text);
  check("the grant writer form's [X] checkbox is never marked as a placeholder",
    !marked.includes("[X]") && !marked.includes("[ ]"), `${marked.join(", ")} (form has [X]: ${text.includes("[X]")})`);
  await page.close();
}

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
const failed = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
