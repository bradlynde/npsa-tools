import { NextRequest } from "next/server";
import { proxyGet } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

/**
 * Read-only view of the curated NSGP deadline table.
 *
 * The table lives with the Sales Toolbox app, which is where it is maintained —
 * adding, editing and promoting a row to "confirmed" all stay there. This exists
 * so the toolbox landing page can answer "is anything open right now?" without
 * making someone open the generator to find out.
 *
 * GET only, matching every other proxy here: writes stay with the app that owns
 * the data, so there is one place a deadline can be changed rather than two.
 */
const ALLOWED = new Set(["deadlines"]);

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyGet(req, "precall", params.path || [], ALLOWED);
}
