import { NextRequest } from "next/server";
import { proxyGet } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "stats",
  "funnel",
  "by-channel",
  "by-campaign",
  "timeseries",
  "bookings",
  "untracked-wins",
]);

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyGet(req, "marketing", params.path || [], ALLOWED);
}
