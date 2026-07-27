// scripts/backfill-wins.js
// One-time backfill of existing Salesforce won opportunities (IsWon = true) into
// the marketing dashboard. Reads scripts/wins-backfill-data.json — an export of
// { Id, AccountName, AccountWebsite, EST_TCV__c, CloseDate } — and POSTs each to
// /api/marketing/wins/ingest, the same endpoint the live Zap uses.
//
// Idempotent: the endpoint dedupes/accumulates per opportunity id, so re-running
// is safe (and safe to run alongside the live Zap).
//
// After posting every win, it calls /wins/reconcile with the full authoritative
// id list, which DELETES any sf_wins row not in this file — clearing wins that were
// reopened, deleted, re-staged, or ingested during testing, so the dashboard can
// never drift above Salesforce.
//
// Needs network egress to the Railway app. Node 18+ (built-in fetch), no npm install.
//   INGEST_URL="https://loe-generator-production.up.railway.app/api/marketing/wins/ingest" \
//   ZAPIER_WEBHOOK_SECRET="<same secret set on the loe-generator Railway service>" \
//   node scripts/backfill-wins.js
//
// Refresh the data file anytime by re-running this SOQL and saving the rows (the
// company started on security grants 2024-10-01, so that is the floor):
//   SELECT Id, Account.Name AccountName, Account.Website AccountWebsite, EST_TCV__c, CloseDate
//   FROM Opportunity
//   WHERE StageName = 'Won - Data Migrated to 2012 Processes' AND CloseDate >= 2024-10-01

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const INGEST_URL = process.env.INGEST_URL
  || 'https://loe-generator-production.up.railway.app/api/marketing/wins/ingest';
const RECONCILE_URL = process.env.RECONCILE_URL || INGEST_URL.replace(/\/ingest$/, '/reconcile');
const SECRET = process.env.ZAPIER_WEBHOOK_SECRET || '';
if (!SECRET) {
  console.error('Set ZAPIER_WEBHOOK_SECRET (same value as the loe-generator Railway service).');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(await readFile(path.join(__dirname, 'wins-backfill-data.json'), 'utf8'));

let matched = 0, unmatched = 0, failed = 0;
const misses = [];
for (const r of rows) {
  const body = {
    opportunity_id: r.Id,
    organization: r.AccountName || null,
    domain: r.AccountWebsite || null,   // endpoint strips protocol/www/path
    amount: r.EST_TCV__c ?? 0,
    close_date: r.CloseDate || null,
  };
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-zap-secret': SECRET },
      body: JSON.stringify(body),
    });
    if (!res.ok) { failed++; console.error('HTTP', res.status, body.organization); continue; }
    const j = await res.json();
    if (j.matched) matched++;
    else { unmatched++; misses.push(body.organization); }
  } catch (e) {
    failed++;
    console.error('error', body.organization, e.message);
  }
  await new Promise((res) => setTimeout(res, 60)); // gentle pace
}

console.log(`\nBackfill complete. matched: ${matched}, unmatched: ${unmatched}, failed: ${failed} (of ${rows.length})`);
if (misses.length) {
  console.log('\nUnmatched — a won client with no tracked booking to attach to (expected for some):');
  for (const m of misses) console.log('  - ' + m);
}

// Reconcile: remove any sf_wins row not in this authoritative set.
try {
  const res = await fetch(RECONCILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-zap-secret': SECRET },
    body: JSON.stringify({ opportunity_ids: rows.map((r) => r.Id) }),
  });
  if (!res.ok) {
    console.error(`\nReconcile failed: HTTP ${res.status}. sf_wins may still contain stale rows.`);
  } else {
    const j = await res.json();
    console.log(`\nReconcile complete. kept: ${j.kept}, removed: ${j.removed}${j.removed ? ' (' + (j.removed_ids || []).join(', ') + ')' : ''}`);
  }
} catch (e) {
  console.error('\nReconcile error:', e.message);
}
