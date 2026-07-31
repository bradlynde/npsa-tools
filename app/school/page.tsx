import { redirect } from "next/navigation";

// School and Church are one "Contact Scraper" view now; the type is a filter there.
// The route stays so existing links and RunDetailPage's back-link keep working.
export default function SchoolScraperPage() {
  redirect("/scraper");
}
