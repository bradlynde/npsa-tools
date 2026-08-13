import { NextRequest } from "next/server";
import { proxyAuth } from "../../../../lib/authProxy";

/** Ask the auth service to email a sign-in code. Always answers 200. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyAuth(req, "/auth/request-code");
}
