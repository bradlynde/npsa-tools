#!/usr/bin/env node
/*
 * Deadline editor check.
 *
 * Two complaints, both about the same dialog. Stuart: "deadlines popup has on
 * pre-call notes generator under dark mode doesn't have a visual popout box.
 * also can we turn this into a state selector ... this visually is difficult to
 * manage. also is there any way to indicate the last time that information was
 * updated."
 *
 * The first is measurable rather than a matter of taste: the panel was painted
 * --bg, which in dark mode is the page underneath it, so the dialog had no edge.
 * This asserts the panel's own background differs from the page's in BOTH
 * themes — the light theme passed by accident before (white on warm paper) and
 * should keep passing on purpose.
 *
 * The rest drives the dialog the way a maintainer does: open it, pick a state,
 * and check that what comes back is that state's dates and nothing else, with
 * the agency, the state-funded program and the three freshness dates beside them.
 *
 *   npx vite --port 5173 &
 *   node scripts/deadline-editor.mjs
 */

const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE_URL || "http://localhost:5173";
const SHOT = process.env.SHOT_DIR || "";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is not installed — `npm i -D playwright-core`");
  process.exit(2);
}

/* A stand-in for the table, shaped like what the API returns: one federal cycle
   per year for Illinois, a state-funded cycle beside it, and another state that
   must NOT appear once Illinois is picked. */
const PAYLOAD = {
  deadlines: [
    { id: 1, state: "IL", program: "federal", cycle_year: 2026, deadline: "2026-05-15", kind: "sub_applicant",
      note: "Submit to IEMA.", source: "iema.illinois.gov", confidence: "confirmed", layer: "verified",
      updated_at: "2026-08-08T12:00:00Z" },
    { id: 2, state: "IL", program: "federal", cycle_year: 2025, deadline: "2025-05-16", kind: "sub_applicant",
      note: "", source: "iema.illinois.gov", confidence: "illustrative", layer: "knowledge-base",
      updated_at: "2026-06-01T12:00:00Z" },
    { id: 3, state: "IL", program: "NSGP-IL", cycle_year: 2026, deadline: "2026-03-01", kind: "state_program",
      note: "75-day window.", source: "illinois.gov", confidence: "confirmed", layer: "manual",
      updated_at: "2026-08-20T12:00:00Z" },
    { id: 4, state: "TX", program: "federal", cycle_year: 2026, deadline: "2026-02-11", kind: "sub_applicant",
      note: "Closes in February.", source: "txdps.state.tx.us", confidence: "confirmed", layer: "verified",
      updated_at: "2026-08-08T12:00:00Z" },
  ],
  reference: {
    checkedOn: "2026-08-08",
    notCovered: ["AS", "GU"],
    states: {
      IL: {
        saa: "Illinois Emergency Management Agency & Office of Homeland Security",
        saaShort: "IEMA", lastVerified: "June 2026",
        programs: [{ acronym: "NSGP-IL", name: "Illinois state-funded Nonprofit Security Grant Program",
                     perSite: 150000, perApplicant: 450000, stackable: "verify", note: "GATA portal is a hard gate." }],
      },
      TX: { saa: "Texas Office of the Governor", saaShort: "TxOOG", lastVerified: "May 13, 2026", programs: [] },
    },
  },
};

const browser = await chromium.launch({ executablePath: CHROME });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) fails.push(what); };

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.route("**/api/precall/deadlines", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PAYLOAD) }));

  await page.goto(`${BASE}/?view=precall&theme=${theme}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Deadlines/ }).click();
  await page.getByText("NSGP Deadlines").waitFor();

  /* The bug, measured: the dialog's own surface against the page behind it. */
  const { panel, page: pageBg } = await page.evaluate(() => {
    const title = [...document.querySelectorAll("div")].find((d) => d.textContent.trim() === "NSGP Deadlines");
    const box = title.closest("div[style*='border-radius']") || title.parentElement.parentElement;
    return { panel: getComputedStyle(box).backgroundColor, page: getComputedStyle(document.body).backgroundColor };
  });
  check(panel !== pageBg && !/rgba\(0, 0, 0, 0\)/.test(panel),
    `${theme}: dialog has its own surface (panel ${panel} vs page ${pageBg})`);

  /* The grid first, then one state. */
  check(await page.getByRole("button", { name: /^IL/ }).isVisible(), `${theme}: jurisdiction grid lists IL`);
  await page.getByRole("button", { name: /^IL/ }).click();

  const body = await page.locator("body").innerText();
  check(/Illinois Emergency Management Agency/.test(body), `${theme}: shows the state's administering agency`);
  check(/June 2026/.test(body) && /Aug 8, 2026/.test(body) && /Aug 20, 2026/.test(body),
    `${theme}: reports Drive verification, web check and last table edit`);
  check(/Federal NSGP/.test(body) && /FY2026/.test(body) && /FY2025/.test(body), `${theme}: federal cycles are grouped together`);
  check(/Illinois state-funded/.test(body) && /\$150,000\/site/.test(body), `${theme}: the state-funded program travels with its cap`);
  check(!/txdps|Closes in February/.test(body), `${theme}: another state's rows stay out of view`);
  check(/verify/.test(body) && /confirmed/.test(body), `${theme}: confidence stays visible per cycle`);

  if (SHOT) await page.screenshot({ path: `${SHOT}/deadlines-${theme}.png`, fullPage: false });
  await page.close();
}

await browser.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
