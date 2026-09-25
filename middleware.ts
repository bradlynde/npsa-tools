import { NextResponse, type NextRequest } from "next/server";
import { LAST_SECTION_COOKIE, landingPath } from "./lib/landing";

/**
 * "/" opens on the section each person used last (lib/landing.ts).
 *
 * Done here rather than in the page because the shell holds the page back until
 * it has checked the login, so a redirect thrown by the page could only happen
 * in the browser, after the scripts load. This answers with a 307 before anything
 * renders. app/page.tsx does the same, should a request ever skip middleware.
 */
export function middleware(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = landingPath(req.cookies.get(LAST_SECTION_COOKIE)?.value);
  return NextResponse.redirect(url, 307);
}

export const config = { matcher: "/" };
