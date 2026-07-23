// scripts/test-instantly-match.js
// Quick manual check of the Instantly reverse-match. For each email it prints
// every campaign that email is a lead in (most-recent first) and the one the
// dashboard would store (the first / most-recent).
//
// Uses the SAME functions server/marketing.js uses, so a green run here means
// enrichment's reverse_email path works.
//
// Needs outbound network to api.instantly.ai — it will NOT run from a locked-down
// CI sandbox. Run it from your machine, a Cowork "Code" session, or the Railway
// service shell. Node 18+ (built-in fetch), no npm install.
//
//   INSTANTLY_API_KEY="<same key set on the loe-generator Railway service>" \
//   node scripts/test-instantly-match.js
//
// Optionally pass emails to check specific ones:
//   node scripts/test-instantly-match.js someone@example.com other@example.com
//
// Expected for the two known emails (attribution = most-recent campaign):
//   walter.nobles@cwclife.com -> IL Outreach - Uncontacted (6-step)
//   ckennedy@gfccsf.org       -> CA Outreach - CSNSGP FY26 (6-step)   [also in: Broader Church Campaign - Phase 1]

import { instantlyCampaignMap, instantlyLeadsForEmail } from '../server/marketing.js';

const emails = process.argv.slice(2);
if (!emails.length) emails.push('ckennedy@gfccsf.org', 'walter.nobles@cwclife.com');

if (!process.env.INSTANTLY_API_KEY) {
  console.error('Set INSTANTLY_API_KEY (same value as the loe-generator Railway service).');
  process.exit(1);
}

const map = await instantlyCampaignMap();
console.log(`Loaded ${Object.keys(map).length} campaigns from Instantly.\n`);

let missing = 0;
for (const email of emails) {
  const leads = await instantlyLeadsForEmail(email);
  const names = [];
  for (const l of leads) {
    const n = map[l.campaign];
    if (n && !names.includes(n)) names.push(n);
  }
  if (names.length) {
    console.log(`${email}`);
    console.log(`  chosen : ${names[0]}`);
    if (names.length > 1) console.log(`  also in: ${names.slice(1).join(' | ')}`);
    console.log('');
  } else {
    missing++;
    console.log(`${email}`);
    console.log(`  -> NO campaign matched (${leads.length} exact-email lead record(s) found)\n`);
  }
}

console.log(missing ? `${missing}/${emails.length} email(s) unresolved.` : `All ${emails.length} email(s) resolved.`);
process.exit(missing ? 1 : 0);
