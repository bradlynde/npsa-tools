#!/usr/bin/env node
/*
 * Dark mode check.
 *
 * The rule worth pinning is the one Stuart set: darken the room, not the
 * document. The engagement letter is client-facing paper and stays white in
 * either theme — it is the single thing in this app that must NOT respond to
 * the token swap, and it sits directly inside a container that does.
 *
 * Also checks that the theme actually arrives. The app is framed cross-origin
 * by the toolbox shell, so it cannot read the shell's localStorage; the mode is
 * relayed by postMessage (see ToolFrame.tsx and src/main.jsx). A silent failure
 * there looks exactly like "dark mode was never built".
 *
 *   npx vite --port 5173 &
 *   node scripts/theme.mjs
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

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const LETTERS = [
  { id: 1, client_name: "Peoria Christian School", rep_name: "Brad", doc_tab: "inh",
    updated_at: "2026-08-25T12:00:00Z" },
  { id: 2, client_name: "Second Church of Christ", rep_name: "Chad", doc_tab: "gw",
    updated_at: "2026-08-25T12:00:00Z" },
];

const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\//, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // Registered second so it wins: Playwright matches the newest route first.
  await page.route(/\/api\/letters/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LETTERS) }));
  await page.goto(`${BASE}/${query}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return page;
};

const bg = (page, sel) =>
  page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);

// ── the letter stays paper ───────────────────────────────────────────────
const dark = await open("?view=generator&theme=dark");
const darkBody = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
const darkDesk = await bg(dark, ".wz-preview");
const darkPaper = await bg(dark, ".wz-preview > div");

check("dark mode reaches the page", darkBody === "rgb(16, 22, 30)", darkBody);
check("the desk around the letter dims", darkDesk === "rgb(11, 16, 22)", darkDesk);
check("THE LETTER STAYS WHITE PAPER", darkPaper === "rgb(255, 255, 255)", darkPaper);

// A dark letter would still be "white on something dark" if only the text moved,
// so the body copy is checked too — it must stay near-black on the page.
const inkOnPaper = await dark.locator(".wz-preview > div").first()
  .evaluate((el) => getComputedStyle(el).color);
check("and its text stays dark ink", /rgb\((\d+), \1, \1\)|rgb\(26, 26, 26\)|rgb\(24, 34, 48\)/.test(inkOnPaper)
  || parseInt(inkOnPaper.match(/\d+/)[0], 10) < 120, inkOnPaper);

/*
 * ...and the brand navy on the paper is the SAME navy top to bottom.
 *
 * Stuart: "the blue lines that separate each section are a lighter blue than the
 * rest of the document, it needs to match the blue that is near the top of the
 * letter." --navy lightens to #4a8bc4 in dark mode so it stays legible on a dark
 * page, and the section rules read it while the letterhead above them is a
 * literal #1e3a5f — two blues on one page, in the document the client receives.
 * The paper pins the hue now, and this compares the two rather than naming a hex,
 * because the failure was a relationship between them.
 */
const letterhead = await dark.locator(".npsa-paper > div").first()
  .evaluate((el) => getComputedStyle(el).borderBottomColor);
const sectionRule = await dark.locator(".npsa-paper div").filter({ hasText: /^I+\.? / }).first()
  .evaluate((el) => getComputedStyle(el).borderBottomColor).catch(() => null);
check("the letterhead rule is the brand navy", letterhead === "rgb(30, 58, 95)", letterhead);
check("and every section rule matches it", sectionRule === letterhead,
  `letterhead ${letterhead} vs section ${sectionRule}`);
await dark.close();

// ── light is unchanged ───────────────────────────────────────────────────
const light = await open("?view=generator&theme=light");
const lightBody = await light.evaluate(() => getComputedStyle(document.body).backgroundColor);
check("light mode is still the warm paper background", lightBody === "rgb(251, 250, 248)", lightBody);
check("and the desk is still the warm border tone",
  (await bg(light, ".wz-preview")) === "rgb(231, 226, 214)");
await light.close();

// ── the shell's message is what actually drives it ───────────────────────
const framed = await open("?view=precall");
await framed.evaluate(() => window.postMessage({ type: "npsa:theme", mode: "dark" }, "*"));
await framed.waitForTimeout(250);
check("a theme message from the shell switches the app",
  await framed.evaluate(() => document.body.classList.contains("dark")));
await framed.evaluate(() => window.postMessage({ type: "npsa:theme", mode: "light" }, "*"));
await framed.waitForTimeout(250);
check("and switches it back",
  await framed.evaluate(() => !document.body.classList.contains("dark")));
await framed.close();

// ── the dialogs that open over the screens ───────────────────────────────
/*
 * Dark mode was given to the screens but not to the modals on top of them. Each
 * modal card reads var(--card) and duly went dark, while the rows and buttons
 * inside it kept hard-coded #fff / #f5f5f5 fills — so Saved Letters rendered
 * near-white var(--ink) on a white row, about 1.05:1, and Stuart could not read
 * his own client list.
 *
 * The contrast is computed rather than compared against an expected hex. The
 * defect was a *relationship* between two colours; pinning either one alone
 * lets the other drift back into it. It also failed silently on inspection —
 * the row looked plausible in a screenshot until the ratio was measured.
 */
const chan = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const lum = (s) => { const [r, g, b] = rgb(s).map(chan); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The nearest ancestor that actually paints — a transparent row shows the card.
const PAINTED = `(el) => {
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    const m = c.match(/[\\d.]+/g);
    if (m && (m.length < 4 || Number(m[3]) > 0)) return c;
  }
  return "rgb(255, 255, 255)";
}`;

for (const mode of ["dark", "light"]) {
  const page = await open(`?view=letters&theme=${mode}`);
  const cell = page.locator("table tbody tr td").first();
  const seen = await cell.evaluate(
    (el, painted) => ({
      fg: getComputedStyle(el).color,
      bg: new Function("return " + painted)()(el),
      text: el.textContent,
    }), PAINTED);

  const r = ratio(seen.fg, seen.bg);
  check(`saved letters are readable in ${mode} mode`, r >= 7,
    `"${seen.text}" ${seen.fg} on ${seen.bg} = ${r.toFixed(2)}:1`);
  await page.close();
}

// The row must not paint its own light fill behind the themed card.
const letters = await open("?view=letters&theme=dark");
const rowBg = await letters.locator("table tbody tr").first()
  .evaluate((el) => getComputedStyle(el).backgroundColor);
check("and no row paints a light fill of its own",
  /rgba\(0, 0, 0, 0\)/.test(rowBg) || lum(rowBg) < 0.2, rowBg);
await letters.close();

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
