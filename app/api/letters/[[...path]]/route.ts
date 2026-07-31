import { NextRequest } from "next/server";
import { proxyGet } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

// "" is the collection root (/api/letters); "stats" is the totals + leaderboard.
// Individual letter bodies are deliberately not proxied — the LOE app owns those.
const ALLOWED = new Set(["", "stats"]);

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return proxyGet(req, "letters", params.path || [], ALLOWED);
}
