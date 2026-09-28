/**
 * Where "/" sends people: the section they used last.
 *
 * The shell writes a cookie as people move between sections (AppShell), and
 * app/page.tsx reads it on the server, so the redirect happens before anything
 * paints. Only the top-level sections count. A deep link into a scraper run or
 * a letter is remembered as its section, never as somebody's front door.
 *
 * Kept free of React and of "use client" so the server page can import it.
 * The sidebar's own list lives in components/Nav.tsx; keep the two in step.
 */

export const LAST_SECTION_COOKIE = "npsa-last";

/** Where a first visit lands, and where a stale or unknown cookie falls back to. */
export const HOME = "/report";

const SECTIONS: { path: string; match: RegExp }[] = [
  { path: "/report", match: /^\/report(\/|$)/ },
  { path: "/marketing", match: /^\/marketing(\/|$)/ },
  { path: "/toolbox", match: /^\/(toolbox|loe)(\/|$)/ },
  { path: "/grant-writing", match: /^\/grant-writing(\/|$)/ },
  { path: "/grant-knowledge", match: /^\/grant-knowledge(\/|$)/ },
  { path: "/scraper", match: /^\/(scraper|school|church)(\/|$)/ },
];

/** The section a path belongs to, or null for anything that isn't one (the client intake form, say). */
export function sectionOf(pathname: string): string | null {
  return SECTIONS.find((s) => s.match.test(pathname))?.path ?? null;
}

/** Only a known section is honoured, so the cookie can never send anyone off-site. */
export function landingPath(saved: string | undefined): string {
  return saved && SECTIONS.some((s) => s.path === saved) ? saved : HOME;
}

/** The cookie line for document.cookie. A year outlasts any gap between visits. */
export function rememberSection(path: string): string {
  return `${LAST_SECTION_COOKIE}=${path}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
