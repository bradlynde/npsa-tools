import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin login proxy.
 *
 * The auth service allows an exact list of origins via CORS_ORIGINS, so a
 * browser calling it directly from a Vercel *preview* URL is blocked — every
 * preview gets a new hostname. Going through this route means the browser only
 * ever talks to our own domain and the cross-origin hop happens server-side,
 * where CORS doesn't apply. Previews work without touching Railway.
 *
 * AuthContext falls back to calling the auth service directly if this route is
 * unavailable, so login keeps working exactly as before either way.
 */

export const dynamic = "force-dynamic";

function authBaseUrl(): string {
  const url =
    process.env.AUTH_API_URL ||
    process.env.NEXT_PUBLIC_AUTH_API_URL ||
    process.env.NEXT_PUBLIC_SCHOOL_API_URL ||
    "https://npsa-scraper.up.railway.app";
  const withProto = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProto.replace(/\/+$/, "");
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${authBaseUrl()}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        // Credentials pass through this response; never let it be cached.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // 502 signals "proxy unavailable" so the client can retry directly.
    return NextResponse.json(
      { error: `Auth service unreachable: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}
