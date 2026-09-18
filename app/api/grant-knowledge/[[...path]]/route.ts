import { NextRequest, NextResponse } from "next/server";
import { proxyRequest } from "../../../../lib/loeProxy";

export const dynamic = "force-dynamic";

/**
 * The Grant Knowledge tab's way to the knowledge base on the Sales Toolbox backend.
 *
 * Those routes are keyed, so this adds the key from a server-side variable after
 * checking the team login, and passes the logged-in person's name along (X-Actor):
 * every edit is kept in a history, and the history should say who.
 *
 * Exactly the paths the tab uses are let through, by shape. A browser can set the
 * facts on a record and nothing else: `origin`, `status`, `verified_by` and the
 * actor are decided by the backend. Import and export are not reachable from here.
 *
 *   GET   overview · search · needs-attention · revisions · files
 *         jurisdictions/<CODE>[/requirements|/revisions] · records/<id>[/revisions]
 *         files/<id>
 *   POST  records · records/<id>/(verify|unverify|archive|restore)
 *         revisions/<id>/revert · jurisdictions/<CODE>/verify-bulk
 *         files/ticket · files/<id>/(archive|restore)
 *   PATCH records/<id>
 *
 * The file itself never comes through here: a ticket from files/ticket lets the
 * browser post it to the backend directly, which is how a 25 MB NOFO gets past
 * the 4.5 MB body cap on these functions.
 */
const CODE = /^[A-Z]{2}$/;
const ID = /^\d{1,9}$/;
const MOVES = new Set(["verify", "unverify", "archive", "restore"]);
const FILE_MOVES = new Set(["archive", "restore"]);
const BODY_KEYS = new Set(["jurisdiction", "kind", "parent_id", "key", "data", "version", "source_url", "sort_order", "reason", "verify", "ids", "record_id", "label"]);

const getOk = (s: string[]) =>
  (s.length === 1 && ["overview", "search", "needs-attention", "revisions"].includes(s[0])) ||
  (s[0] === "jurisdictions" && CODE.test(s[1] || "") && (s.length === 2 || (s.length === 3 && ["requirements", "revisions"].includes(s[2])))) ||
  (s[0] === "records" && ID.test(s[1] || "") && (s.length === 2 || (s.length === 3 && s[2] === "revisions"))) ||
  // files/<id>/content is deliberately absent: the bytes are fetched straight from
  // the backend on the signed link a file listing hands back.
  (s[0] === "files" && (s.length === 1 || (s.length === 2 && ID.test(s[1]))));

const postOk = (s: string[]) =>
  (s.length === 1 && s[0] === "records") ||
  (s.length === 3 && s[0] === "records" && ID.test(s[1]) && MOVES.has(s[2])) ||
  (s.length === 3 && s[0] === "revisions" && ID.test(s[1]) && s[2] === "revert") ||
  (s.length === 3 && s[0] === "jurisdictions" && CODE.test(s[1]) && s[2] === "verify-bulk") ||
  (s.length === 2 && s[0] === "files" && s[1] === "ticket") ||
  (s.length === 3 && s[0] === "files" && ID.test(s[1]) && FILE_MOVES.has(s[2]));

const patchOk = (s: string[]) => s.length === 2 && s[0] === "records" && ID.test(s[1]);

function upstreamKey(): string {
  return process.env.LOE_API_KEY || process.env.NPSA_MCP_KEY || "";
}
const notConfigured = () =>
  NextResponse.json({ error: "The grant knowledge proxy is not configured (LOE_API_KEY is unset on Vercel)" }, { status: 503 });

async function filteredBody(req: NextRequest): Promise<string | null> {
  try {
    const raw = await req.json();
    return JSON.stringify(Object.fromEntries(Object.entries(raw || {}).filter(([k]) => BODY_KEYS.has(k))));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const key = upstreamKey();
  if (!key) return notConfigured();
  return proxyRequest(req, "grant-knowledge", params.path || [], new Set(), "GET", { upstreamKey: key, allowIf: getOk, forwardActor: true });
}

export async function POST(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const key = upstreamKey();
  if (!key) return notConfigured();
  const body = await filteredBody(req);
  if (body === null) return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  return proxyRequest(req, "grant-knowledge", params.path || [], new Set(), "POST", { upstreamKey: key, allowIf: postOk, forwardActor: true, body });
}

export async function PATCH(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const key = upstreamKey();
  if (!key) return notConfigured();
  const body = await filteredBody(req);
  if (body === null) return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  return proxyRequest(req, "grant-knowledge", params.path || [], new Set(), "PATCH", { upstreamKey: key, allowIf: patchOk, forwardActor: true, body });
}
