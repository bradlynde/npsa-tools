import { NextRequest } from "next/server";
import { proxyRequest } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

const READABLE = new Set([
  "stats",
  "funnel",
  "by-channel",
  "by-campaign",
  "timeseries",
  "sales-timeseries",
  "applications", // applications/stats
  "sync", // sync/status
  "bookings",
  "untracked-wins",
  // No longer rendered. The panel that showed this came off once the two totals
  // were reconciled in Salesforce, but the endpoint is how you re-check that they
  // still agree — open it directly rather than reading it off the dashboard.
  "revenue-quality",
]);

// Writes the dashboard actually performs, and nothing more. Ingest and the
// Salesforce reconcile jobs stay with the Sales Toolbox app.
const PATCHABLE = new Set(["bookings"]); // toggle Held / LOE on one booking
const POSTABLE = new Set(["enrich"]); // "Refresh data"

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], READABLE, "GET");
}

export async function PATCH(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], PATCHABLE, "PATCH");
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], POSTABLE, "POST");
}
