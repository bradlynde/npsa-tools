import { NextRequest, NextResponse } from "next/server";
import { loeBaseUrl } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

/**
 * Same-origin passthrough for the client intake page's own calls.
 *
 * The page at /client/<slug> saves answers to /api/intake/<slug>/answers, marks
 * itself complete at /api/intake/<slug>/complete, and (later) uploads files at
 * /api/intake/<slug>/upload. Those routes live on the Sales Toolbox backend and
 * are gated by the client's token, which travels in the X-Intake-Token header and
 * is forwarded here untouched. No team login: this is the client's side.
 *
 * Only the two client verbs are forwarded, and only under /api/intake, so the
 * keyed team routes (/api/clients) are not reachable through here.
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ACTIONS = new Set(["answers", "complete", "upload"]);

async function forward(req: NextRequest, segments: string[], method: "PUT" | "POST") {
  const [slug, action, ...rest] = segments;
  if (!slug || !SLUG.test(slug) || !action || !ACTIONS.has(action) || rest.length) {
    return NextResponse.json({ error: "No such route" }, { status: 404 });
  }
  const token = req.headers.get("x-intake-token") || "";
  if (!token) return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 401 });

  const body = await req.arrayBuffer();
  try {
    const upstream = await fetch(`${loeBaseUrl()}/api/intake/${slug}/${action}`, {
      method,
      headers: {
        Accept: "application/json",
        "X-Intake-Token": token,
        ...(req.headers.get("content-type") ? { "Content-Type": req.headers.get("content-type") as string } : {}),
      },
      body: body.byteLength ? body : undefined,
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
      { error: `Could not reach the form service: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

export async function PUT(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path || [], "PUT");
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path || [], "POST");
}
