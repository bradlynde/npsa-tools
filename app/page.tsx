import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_SECTION_COOKIE, landingPath } from "../lib/landing";

/**
 * The front door opens wherever each person left off: the Company Report for
 * some, Marketing or the Sales Toolbox for others. A first visit lands on the
 * Company Report. See lib/landing.ts.
 *
 * middleware.ts normally answers "/" before this renders; this is the fallback.
 */
export default function Home() {
  redirect(landingPath(cookies().get(LAST_SECTION_COOKIE)?.value));
}
