import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin proxy to the auth service.
 *
 * The auth service allows an exact list of origins via CORS_ORIGINS, so a
 * browser calling it directly from a Vercel *preview* URL is blocked — every
 * preview gets a new hostname. Going through our own domain means the
 * cross-origin hop happens server-side, where CORS doesn't apply.
 *
 * AuthContext falls back to calling the service directly when a route here is
 * missing or can't reach it, so sign-in works either way.
 */

export function authBaseUrl(): string {
  const url =
    process.env.AUTH_API_URL ||
    process.env.NEXT_PUBLIC_AUTH_API_URL ||
    process.env.NEXT_PUBLIC_SCHOOL_API_URL ||
    "https://npsa-scraper.up.railway.app";
  const withProto = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProto.replace(/\/+$/, "");
}

export async function proxyAuth(req: NextRequest, path: string): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${authBaseUrl()}${path}`, {
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
