import assert from "node:assert/strict";
import { applyKind, buildUrl, creditText, creditedAsText, tagsText, utmSlug, EMPTY_TAGS } from "./links.ts";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
};

const CHAD = "https://calendly.com/chad-nonprofitsecurityadvisors/new-meeting";

t("builds Michael's CITN link exactly", () => {
  assert.equal(
    buildUrl(CHAD, { utm_source: "church_it_network", utm_medium: "in_person_event", utm_campaign: "citn_2026", utm_content: "printed_material" }),
    `${CHAD}?utm_source=church_it_network&utm_medium=in_person_event&utm_campaign=citn_2026&utm_content=printed_material`
  );
});
t("skips blank tags and slugs the rest", () => {
  assert.equal(buildUrl(CHAD, { ...EMPTY_TAGS, utm_source: "Jeff ", utm_medium: "Email" }), `${CHAD}?utm_source=jeff&utm_medium=email`);
});
t("replaces tags already on the base link", () => {
  assert.equal(buildUrl(`${CHAD}?utm_source=old&month=2026-10`, { ...EMPTY_TAGS, utm_source: "new", utm_medium: "email" }),
    `${CHAD}?utm_source=new&month=2026-10&utm_medium=email`);
});
t("no URL until the base is one", () => {
  assert.equal(buildUrl("calendly.com/x", EMPTY_TAGS), null);
  assert.equal(buildUrl("mailto:a@b.org", EMPTY_TAGS), null);
});
t("utmSlug matches upstream", () => {
  assert.equal(utmSlug("  CITN  2026! "), "citn-2026");
  assert.equal(utmSlug("citn_2026"), "citn_2026");
});
t("a kind sets its tags and keeps campaign and content", () => {
  const from = { utm_source: "x", utm_medium: "y", utm_campaign: "citn_2026", utm_content: "flyer" };
  assert.deepEqual(applyKind("linkedin", from), { utm_source: "linkedin", utm_medium: "post", utm_campaign: "citn_2026", utm_content: "flyer" });
  assert.deepEqual(applyKind("event", from), { utm_source: "", utm_medium: "in_person_event", utm_campaign: "citn_2026", utm_content: "flyer" });
  assert.deepEqual(applyKind("custom", from), from);
});
t("credit and usage read as text", () => {
  assert.equal(creditText({ channel: "conference", label: "Conference", detail: "CITN 2026" }), "Conference · CITN 2026");
  assert.equal(creditText({ channel: "email", label: "Email", detail: null }), "Email");
  assert.equal(creditedAsText({ "Organic Search": 1, Instantly: 4 }), "Instantly 4, Organic Search 1");
  assert.equal(tagsText({ utm_source: "google", utm_medium: "organic", utm_campaign: null }), "google / organic / –");
});

console.log(`\n${passed}/7 passed`);
