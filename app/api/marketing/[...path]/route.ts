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
  "links", // the Links panel: list + builder preview
]);

// Writes the dashboard actually performs, and nothing more. Ingest and the
// Salesforce reconcile jobs stay with the Sales Toolbox app.
const PATCHABLE = new Set(["bookings"]); // toggle Held / LOE on one booking
const POSTABLE = new Set(["enrich"]); // "Refresh data"
// The Links panel saves and deletes tracked links. Kept apart from the sets above so
// the creator's name goes upstream with them, the way grant knowledge edits do.
const LINKS = new Set(["links"]);

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], READABLE, "GET");
}

export async function PATCH(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], PATCHABLE, "PATCH");
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path || [];
  if (path[0] === "links") return proxyRequest(req, "marketing", path, LINKS, "POST", { forwardActor: true });
  return proxyRequest(req, "marketing", path, POSTABLE, "POST");
}

export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(req, "marketing", params.path || [], LINKS, "DELETE", { forwardActor: true });
}
