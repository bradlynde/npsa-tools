import { NextRequest } from "next/server";
import { proxyAuth } from "../../../../lib/authProxy";

/** Swap a sign-in token that still works for a fresh one, so active people stay signed in. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyAuth(req, "/auth/refresh");
}
