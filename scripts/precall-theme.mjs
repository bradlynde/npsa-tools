#!/usr/bin/env node
/*
 * Can the rep read their own pre-call notes in dark mode?
 *
 * The notes stylesheet (PC_NOTES_CSS) was written for a white page: #182230
 * headings, #26334d body copy. The card it rendered onto was var(--card), which
 * turns dark navy in dark mode — so the notes came out dark on dark, at roughly
 * 1:1. The fix is the letter's: the notes are a document and sit on white paper
 * in either theme.
 *
 * Contrast is computed for every element that carries text, against the nearest
 * ancestor that actually paints a background, rather than compared against an
 * expected hex. The failure was a relationship between two colours; pinning
 * either one alone lets the other drift back into it.
 *
 * The notes are stubbed with one of each element the model can emit, including
 * ones PC_NOTES_CSS names no rule for (a table, an h4, a bare <em>), since those
 * inherit their colour from wherever the notes happen to sit.
 *
 *   npx vite --port 5173 &
 *   node scripts/precall-theme.mjs
 *
 * Needs playwright-core and a Chromium binary; set CHROME_PATH to override.
 */

const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE_URL || "http://localhost:5173";

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.error("playwright-core is not installed — `npm i -D playwright-core`"); process.exit(2); }

const NOTES = [
  "# Pre-Call Notes — Greenland Hills UMC",
  "",
  "## Meeting Details",
  "- **Date:** October 2, 2026",
  "- Contact: Kevin Merit, [meritdallas.com](https://meritdallas.com)",
  "",
  "### Organization",
  "A 400-member congregation in Dallas. *Referred by First Baptist.*",
  "",
  "1. Confirm the 501(c)(3)",
  "2. Ask about the 2025 break-in",
  "",
  "> Booking form: they asked whether cameras are eligible.",
  "",
  "#### Unstyled heading",
  "",
  "| Question | Answer |",
  "| --- | --- |",
  "| Locations | 2 |",
  "",
  "`SAM.gov` registration pending.",
  "",
  "---",
].join("\n");

const checks = [];
const check = (name, ok, detail = "") => checks.push([name, !!ok, detail]);

const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const AUDIT = () => {
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
  const root = document.querySelector(".pc");
  if (!root) return null;
  let worst = null, count = 0;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    count++;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const big = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const r = ratio(cs.color, painted(el));
    const need = big ? 3 : 4.5;
    const slack = r / need;
    if (!worst || slack < worst.slack) {
      worst = { slack, ratio: r, need, tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 30), fg: cs.color, bg: painted(el) };
    }
  }
  return { worst, count, paper: painted(root) };
};

for (const mode of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\//, (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/precall") return json({ notes: NOTES, website: null, websiteFetched: false });
    if (p === "/api/precall/bookings") return json({ bookings: [], cached: false });
    if (p === "/api/letters/stats") return json({ total: 0 });
    return json({});
  });
  await page.goto(`${BASE}/?view=precall&theme=${mode}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator('input[placeholder="e.g. iThrive Christian Church"]').first().fill("Greenland Hills UMC");
  await page.locator('button:has-text("Generate Pre-Call Notes")').click();
  await page.waitForTimeout(900);

  const a = await page.evaluate(AUDIT);
  check(`${mode}: the notes render`, a && a.count >= 10, a ? `${a.count} text elements` : "no .pc element");
  if (!a) { await page.close(); continue; }
  check(`${mode}: the notes sit on white paper`, a.paper === "rgb(255, 255, 255)", a.paper);
  const w = a.worst;
  check(`${mode}: every line of the notes is readable`, w && w.ratio >= w.need,
    w && `${w.ratio.toFixed(2)}:1 (needs ${w.need}) — <${w.tag}> "${w.text}" ${w.fg} on ${w.bg}`);
  await page.close();
}

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
const failed = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
