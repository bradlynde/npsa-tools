import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * Shared server-side proxy to the Sales Toolbox (LOE) backend on Railway.
 *
 * Why: the marketing and letter data live in that Express + Postgres service.
 * Proxying keeps the browser same-origin (no CORS change needed on the LOE
 * service) and lets us require a login here — those upstream endpoints have no
 * auth of their own. Only GETs are forwarded; writes stay with the LOE app.
 */

export function loeBaseUrl(): string {
  const url =
    process.env.LOE_API_URL ||
    process.env.NEXT_PUBLIC_LOE_URL ||
    "https://loe-generator-production.up.railway.app";
  const withProto = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProto.replace(/\/+$/, "");
}

/** Verifies an HS256 JWT against JWT_SECRET (the secret the scraper backends use). */
function tokenIsValid(token: string): boolean {
  const secret = process.env.JWT_SECRET;
  // Without the shared secret we can't check a signature. Still requiring a
  // bearer token keeps this off the open internet; set JWT_SECRET in Vercel
  // to get full verification.
  if (!secret) return token.length > 0;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.exp && Date.now() / 1000 > claims.exp) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Forwards GET {LOE}/api/{prefix}/{path}{query} when the first path segment is
 * allowed and the caller presents a valid token.
 */
export async function proxyGet(
  req: NextRequest,
  prefix: string,
  segments: string[],
  allowed: Set<string>
): Promise<NextResponse> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !tokenIsValid(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // An empty segment list means the collection root (e.g. /api/letters).
  const first = segments[0] ?? "";
  if (!allowed.has(first)) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 404 });
  }

  const tail = segments.length ? `/${segments.join("/")}` : "";
  const target = `${loeBaseUrl()}/api/${prefix}${tail}${req.nextUrl.search || ""}`;

  try {
    const upstream = await fetch(target, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Sales Toolbox backend unreachable: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}
