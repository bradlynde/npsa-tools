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

const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\//, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
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

await browser.close();
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
