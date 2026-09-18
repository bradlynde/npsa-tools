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

/**
 * Verifies an HS256 JWT against JWT_SECRET (the secret the scraper backends use).
 * `username` comes back only when the signature was actually checked: a name read
 * out of a token nobody verified is a name anyone could have typed.
 */
function verifyToken(token: string): { ok: boolean; username?: string } {
  const secret = process.env.JWT_SECRET;
  // Without the shared secret we can't check a signature. Still requiring a
  // bearer token keeps this off the open internet; set JWT_SECRET in Vercel
  // to get full verification.
  if (!secret) return { ok: token.length > 0 };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  const [header, payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.exp && Date.now() / 1000 > claims.exp) return { ok: false };
    return { ok: true, username: typeof claims.username === "string" ? claims.username : undefined };
  } catch {
    return { ok: false };
  }
}

/**
 * Forwards {method} {LOE}/api/{prefix}/{path}{query} when the first path segment
 * is allowed and the caller presents a valid token.
 *
 * Writes are limited to the two the dashboard needs: toggling a booking's
 * Held / LOE flags, and kicking off enrichment ("Refresh data"). Everything
 * else stays read-only.
 */
export async function proxyRequest(
  req: NextRequest,
  prefix: string,
  segments: string[],
  allowed: Set<string>,
  method: "GET" | "POST" | "PATCH" = "GET",
  options: {
    /** Bearer sent upstream. The grant-client routes on the LOE service are keyed. */
    upstreamKey?: string;
    /** Allow the request when the first segment passes this test, not only when it is in `allowed`. */
    allowIf?: (segments: string[]) => boolean;
    /** Send this JSON body upstream instead of the request's own (after the route has filtered it). */
    body?: string;
    /**
     * Tell the backend who is logged in (X-Actor), for routes that keep an edit
     * history. The backend believes it only from the key on its ACTOR_PROXY_KEYS.
     * A write is refused when the name cannot be verified, so history never records
     * a name the browser merely claimed.
     */
    forwardActor?: boolean;
  } = {}
): Promise<NextResponse> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const who = token ? verifyToken(token) : { ok: false };
  if (!who.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (options.forwardActor && method !== "GET" && !who.username) {
    return NextResponse.json(
      { error: "Edits are off: this deployment cannot verify who is logged in (JWT_SECRET is unset on Vercel)" },
      { status: 503 }
    );
  }

  // An empty segment list means the collection root (e.g. /api/letters).
  const first = segments[0] ?? "";
  if (!allowed.has(first) && !(options.allowIf && options.allowIf(segments))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 404 });
  }

  const tail = segments.length ? `/${segments.join("/")}` : "";
  const target = `${loeBaseUrl()}/api/${prefix}${tail}${req.nextUrl.search || ""}`;

  let body: string | undefined;
  if (method !== "GET") {
    body = options.body ?? (await req.text().catch(() => ""));
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...(options.upstreamKey ? { Authorization: `Bearer ${options.upstreamKey}` } : {}),
        ...(options.forwardActor && who.username ? { "X-Actor": who.username } : {}),
      },
      body: method === "GET" ? undefined : body || "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Sales Toolbox backend unreachable: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

/** Back-compat alias — most callers only read. */
export const proxyGet = (
  req: NextRequest,
  prefix: string,
  segments: string[],
  allowed: Set<string>
) => proxyRequest(req, prefix, segments, allowed, "GET");
