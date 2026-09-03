import { NextRequest, NextResponse } from "next/server";
import { loeBaseUrl } from "../../../lib/loeProxy";

export const dynamic = "force-dynamic";

/**
 * The client-facing NSGP intake page, served from this domain.
 *
 * The page itself lives with the Sales Toolbox backend on Railway
 * (server/intake/client.html there), which checks the client's token and fills in
 * their answers. This route only forwards the request and hands back the HTML, so
 * clients get an npsa-tools address in their inbox rather than a railway.app one,
 * and the same origin serves the page and its API calls (see app/api/intake).
 *
 * Deliberately outside the team login: a client shares this link with their own
 * staff, and the token in the link is the only key. A wrong or missing token gets
 * the backend's "link not recognized" page, which is passed through as-is.
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const slug = params.slug || "";
  if (!SLUG.test(slug)) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const target = `${loeBaseUrl()}/client/${slug}${req.nextUrl.search || ""}`;
  try {
    const upstream = await fetch(target, {
      headers: { Accept: "text/html" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const html = await upstream.text();
    return new NextResponse(html, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    return new NextResponse(
      `<!DOCTYPE html><meta charset="utf-8"><title>Client Information Collection</title>
<div style="font-family:system-ui;max-width:560px;margin:80px auto;text-align:center;color:#15242E">
<h2 style="color:#003C60">Client Information Collection</h2>
<p style="color:#566571">The form is temporarily unavailable. Please try again in a few minutes.</p></div>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }
}
