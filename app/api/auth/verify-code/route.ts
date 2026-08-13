import { NextRequest } from "next/server";
import { proxyAuth } from "../../../../lib/authProxy";

/** Exchange an emailed code for a token. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyAuth(req, "/auth/verify-code");
}
