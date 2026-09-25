#!/usr/bin/env node
/*
 * Does the PDF the client receives look like the preview the rep proofread?
 *
 * The print window is built by hand in runPrint(): a bare document that gets
 * previewRef's innerHTML. That leaves the .npsa-paper element behind — and with
 * it every custom property defined on it. Section headings are styled
 * `color: var(--navy)` and `border-bottom: 2px solid var(--navy)`, so in the
 * print document --navy resolved to nothing: the colour fell back to black and
 * the border declaration became invalid at computed-value time, which drops it
 * outright. Every section rule was missing from the client's PDF.
 *
 * Typefaces had the same shape of problem from the other side. The print
 * stylesheet wraps everything in Georgia; on screen only the elements that set
 * fontFamily themselves got it, so the section headings, the parties box and
 * the fee boxes previewed in the app's sans and printed in Georgia.
 *
 * This drives the real Download button and reads the computed styles out of the
 * window the app actually opens, rather than re-creating the print template
 * here — a copy of the template in this file would agree with itself forever.
 *
 *   npx vite --port 5173 &
 *   node scripts/print-parity.mjs
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
let seq = 0;

async function open() {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => errors.push(e.message));
  const alerts = [];
  page.on("dialog", (d) => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/letters/stats") return json({ total: 0 });
    if (p === "/api/reps") return json([{ id: 1, name: "Chad Burgess" }]);
    if (p === "/api/letters" && r.request().method() === "POST") return json({ id: ++seq });
    if (p.startsWith("/api/templates/")) {
      // Served exactly as production serves them. A 404 here sends the app to
      // its built-in fallback, which is an older contract than templates/.
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
  const advanceTo = async (t) => { for (let g = 0; g < 16 && !(await caption()).includes(t); g++) { await page.locator('.wz-btn-primary:has-text("Next")').click(); await page.waitForTimeout(180); } };
  const backTo = async (t) => { for (let g = 0; g < 16 && !(await caption()).includes(t); g++) { await page.locator('.wz-btn:has-text("Back")').click(); await page.waitForTimeout(160); } };
  return { page, caption, advanceTo, backTo, alerts };
}

/*
 * Read the same three properties off the same element in either document.
 * Headings are found by their numeral rather than a class, because the print
 * document carries no React and no class the app owns — only the markup the
 * letter itself emits.
 */
const PROBE = () => {
  const root = document.querySelector(".npsa-paper") || document.body;
  const pick = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return {
      color: c.color,
      rule: c.borderBottomWidth + " " + c.borderBottomStyle + " " + c.borderBottomColor,
      font: c.fontFamily,
    };
  };
  const heading = [...root.querySelectorAll("div")]
    .find((d) => /^[IVX]+\.\s/.test(d.textContent.trim()) && !d.children.length);
  return { heading: pick(heading), paper: pick(root) };
};

// Everything the print window is handed has to survive the trip; compare the
// whole probe rather than one property, since each fix here moved a different one.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function printOf(page) {
  // "Download PDF" on a letter, "Print / Save as PDF" on the grant writer form.
  const button = page.locator(".wz-btn").filter({ hasText: /Download|Print/ }).first();
  // A disabled button is reported rather than waited on: Playwright would sit
  // on it for the full timeout and the run would die instead of failing.
  if (await button.isDisabled()) return { blocked: "the Download button is disabled" };
  const wait = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
  await button.click();
  await page.waitForTimeout(500);
  let pop = await wait;
  if (!pop) {
    // The rep is sent through the save modal first when the document has
    // unsaved changes; the print follows the save.
    const again = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    const rep = page.locator("select").last();
    if (await rep.count()) await rep.selectOption({ label: "Chad Burgess" }).catch(() => {});
    await page.locator('button:has-text("Save"), button:has-text("Update")').last().click();
    await page.waitForTimeout(600);
    pop = await again;
  }
  if (!pop) return null;
  await pop.waitForTimeout(700);
  return pop;
}


/*
 * Everything below is measured on the paper as rendered, not on the source.
 * Each of these was a "looks fine on my screen" defect: the numbers only show
 * up when something reads the computed styles back.
 */
const LEGIBILITY = () => {
  const root = document.querySelector(".npsa-paper");
  const chan = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (s) => { const [r, g, b] = s.match(/[\d.]+/g).slice(0, 3).map(Number).map(chan); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const painted = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const m = c.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0)) return c;
    }
    return "rgb(255, 255, 255)";
  };
  let smallest = null, faintest = null;
  for (const el of root.querySelectorAll("*")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    const alpha = cs.color.match(/[\d.]+/g);
    if (alpha && alpha.length > 3 && Number(alpha[3]) === 0) continue;   // the blank signature line
    const size = parseFloat(cs.fontSize);
    const text = el.textContent.trim().slice(0, 40);
    if (!smallest || size < smallest.size) smallest = { size, text };
    // WCAG large text: 24px, or 18.66px when bold — those need only 3:1.
    const big = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    if (big) continue;
    const r = ratio(cs.color, painted(el));
    if (!faintest || r < faintest.ratio) faintest = { ratio: r, text, color: cs.color };
  }
  return { smallest, faintest };
};

// The two signature columns are one table drawn as two stacks: if a row in one
// is taller than its opposite number, every line below it sits off by that much.
const SIGNATURE_ROWS = () => {
  const root = document.querySelector(".npsa-paper");
  const head = [...root.querySelectorAll("div")]
    .find((d) => /^Acknowledged and Agreed$/i.test(d.textContent.trim()));
  if (!head) return null;
  let block = head.nextElementSibling;
  while (block && !(getComputedStyle(block).display === "flex" && block.children.length === 2)) {
    block = block.nextElementSibling;
  }
  if (!block) return null;
  return [...block.children].map((col) =>
    [...col.querySelectorAll("div")]
      .filter((d) => /^(SIGNATURE|DATE|PRINTED NAME|TITLE)$/i.test(d.textContent.trim()))
      .map((d) => ({ label: d.textContent.trim().toUpperCase(), top: Math.round(d.getBoundingClientRect().top) })));
};

const TYPES = [
  { key: "pre", name: "Grace Fellowship", nameStep: "Client" },
  { key: "inh", chip: "In-House Grant Writing", name: "Beth Shalom Synagogue", nameStep: "Client" },
  { key: "post", radio: "Award Implementation", name: "St. Anne Parish", nameStep: "Client" },
  { key: "addendum", radio: "Addendum", name: "Temple Emanuel", nameStep: "Client" },
  { key: "gw", radio: "3rd Party Grant Writer", name: "Cardinal Grants LLC", nameStep: "Grant Writer" },
];

const build = async (ctx, t) => {
  const { page, advanceTo, backTo } = ctx;
  if (t.radio) {
    await page.locator(`.wz-radio:has-text("${t.radio}") input`).first().check();
    await page.waitForTimeout(450);
  }
  if (t.chip) {
    // The two Pre-Award variants are chips under the type picker, not radio cards.
    await page.getByRole("button", { name: t.chip }).first().click();
    await page.waitForTimeout(450);
  }
  await advanceTo(t.nameStep);
  await page.locator(".wz-input").first().fill(t.name);
  // Without an expiration date the download is refused outright. Not every
  // document type has the field, and it does not sit on the same step in the
  // ones that do, so it is filled wherever it turns up on the way to Review.
  for (let g = 0; g < 16 && !(await ctx.caption()).includes("Review"); g++) {
    const exp = page.locator(".wz-field").filter({ hasText: "Offer Expiration Date" }).locator("input").first();
    if (await exp.count()) { await exp.fill("2026-12-31"); await page.waitForTimeout(200); }
    // Award Implementation dates its second and third payments off this one,
    // and left blank it prints "Month 4 from effective date" instead of a date
    // — so the date-format check would never see those two lines.
    const eff = page.locator(".wz-field").filter({ hasText: "Effective Date" })
      .filter({ hasNotText: "Offer Expiration" }).locator("input").first();
    if (await eff.count()) { await eff.fill("2026-10-01"); await page.waitForTimeout(200); }
    await page.locator('.wz-btn-primary:has-text("Next")').click();
    await page.waitForTimeout(190);
  }
};

for (const t of TYPES) {
  const ctx = await open();
  const { page, alerts } = ctx;
  await build(ctx, t);

  const onScreen = await page.evaluate(PROBE);
  const result = await printOf(page);
  const pop = result && result.blocked ? null : result;

  check(`${t.key}: clicking Download opens a print window`, !!pop,
    result?.blocked || `no popup; alerts: ${alerts.join(" | ") || "none"}`);
  if (!pop) { await page.close(); continue; }

  const inPrint = await pop.evaluate(PROBE);
  check(`${t.key}: the letter prints in the typeface it previewed in`,
    onScreen.paper && inPrint.paper && onScreen.paper.font === inPrint.paper.font,
    `${onScreen.paper?.font} vs ${inPrint.paper?.font}`);

  if (onScreen.heading) {
    check(`${t.key}: section headings keep their colour and rule in print`,
      same(onScreen.heading, inPrint.heading),
      `${JSON.stringify(onScreen.heading)} vs ${JSON.stringify(inPrint.heading)}`);
    // The rule is the thing that actually vanished, so it is named on its own:
    // a `0px none` border is the exact shape of the failure.
    check(`${t.key}: and the rule under each heading is actually drawn`,
      /^2px solid/.test(inPrint.heading?.rule || ""), inPrint.heading?.rule);
  }
  // Every letter type carries headings; one that stops reporting them has
  // stopped rendering rather than started passing.
  // The addendum and the grant writer form number their sections differently
  // (or not at all); every engagement letter carries numerals, and one that
  // stops reporting them has stopped rendering rather than started passing.
  check(`${t.key}: the preview has section headings to compare`,
    t.key === "gw" || t.key === "addendum" || !!onScreen.heading);

  // ── fix 8: nothing on the page is too small or too faint to read ──────
  const legible = await page.evaluate(LEGIBILITY);
  check(`${t.key}: no type on the page is under 8.5pt`,
    legible.smallest && legible.smallest.size >= 11.3,
    `${legible.smallest?.size}px on "${legible.smallest?.text}"`);
  check(`${t.key}: every line of text clears 4.5:1 on its own background`,
    legible.faintest && legible.faintest.ratio >= 4.5,
    `${legible.faintest?.ratio.toFixed(2)}:1 — ${legible.faintest?.color} on "${legible.faintest?.text}"`);

  // ── fix 9: one date format ────────────────────────────────────────────
  const text = await page.locator(".npsa-paper").first().innerText();
  check(`${t.key}: no numeric dates among the long-form ones`,
    !/\b\d{1,2}-\d{1,2}-\d{4}\b/.test(text) && !/\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(text),
    (text.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g) || []).join(", "));
  check(`${t.key}: no abbreviated months either`,
    !/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},/.test(text),
    (text.match(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},[^\n]*/g) || []).join(", "));

  // ── fix 7: the two signature columns line up ──────────────────────────
  if (t.key !== "gw") {
    const cols = await page.evaluate(SIGNATURE_ROWS);
    const offsets = cols && cols[0] && cols[1]
      ? cols[0].map((r, i) => ({ label: r.label, gap: Math.abs(r.top - (cols[1][i]?.top ?? r.top)) }))
      : null;
    check(`${t.key}: the signature block's two columns share a baseline`,
      offsets && offsets.length === 4 && offsets.every((o) => o.gap <= 1),
      offsets ? offsets.filter((o) => o.gap > 1).map((o) => `${o.label} off by ${o.gap}px`).join(", ")
              : "signature block not found");
  }

  await pop.close();
  await page.close();
}

// The Grant Writer agreement: #273 freed the Review-step button, but
// handlePrint kept its own copy of the expiration guard, so the click alerted
// about a field that document does not have and returned without printing.
{
  const ctx = await open();
  const { page, alerts } = ctx;
  await build(ctx, TYPES.find((t) => t.key === "gw"));
  // The form goes to the grant writer to be filled in, so almost every field
  // is empty when it prints — and each empty one printed its own placeholder.
  const gw = await page.locator(".npsa-paper").first().innerText();
  const ghosts = ["Organization Name", "Contact Name", "Billing Address", "$0"]
    .filter((g) => gw.includes(g));
  check("gw: an unfilled field prints an empty line, not a placeholder word",
    ghosts.length === 0, ghosts.join(", "));
  check("gw: the consultant clause does not assume a gender",
    !/his\/her|he\/she|\bhis or her\b/i.test(gw),
    (gw.match(/.{0,40}his\/her.{0,40}/i) || [""])[0].trim());

  const result = await printOf(page);
  const pop = result && result.blocked ? null : result;
  check("gw: no expiration alert stands between the rep and the download",
    !alerts.some((a) => /Expiration Date/i.test(a)), alerts.join(" | "));
  if (pop) await pop.close();
  await page.close();
}

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
const failed = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
