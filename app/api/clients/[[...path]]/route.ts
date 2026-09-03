import { NextRequest, NextResponse } from "next/server";
import { proxyRequest } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

/**
 * Read-only view of the grant clients for the Grant Writing page.
 *
 * The client records, intake answers and status live with the Sales Toolbox
 * backend, whose /api/clients routes are keyed (intake answers carry EINs,
 * contacts and security incidents). This proxy adds that key from a server-side
 * variable so it never reaches the browser, and requires the team login first.
 *
 * GET only. Registering, seeding and updating clients stay with the MCP tools
 * (client_create, intake_seed, client_update), where each write is confirmed
 * and logged.
 *
 *   /api/clients                     the list, with ?status= &search=
 *   /api/clients/<slug>              one client with contacts and counts
 *   /api/clients/<slug>/status       per-section counts, checklist, uploads
 *   /api/clients/<slug>/answers      the answers (optionally ?section=)
 *   /api/clients/<slug>/uploads      the uploaded files (metadata only)
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SUB = new Set(["status", "answers", "uploads"]);

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const key = process.env.LOE_API_KEY || process.env.NPSA_MCP_KEY || "";
  if (!key) {
    return NextResponse.json(
      { error: "The grant clients proxy is not configured (LOE_API_KEY is unset on Vercel)" },
      { status: 503 }
    );
  }
  const segments = params.path || [];
  return proxyRequest(req, "clients", segments, new Set([""]), "GET", {
    upstreamKey: key,
    allowIf: (s) => s.length >= 1 && s.length <= 2 && SLUG.test(s[0]) && (s.length === 1 || SUB.has(s[1])),
  });
}
