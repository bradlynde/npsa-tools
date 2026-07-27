// scripts/backfill-applications.js
// One-time (and safely repeatable) load of Salesforce grant Applications
// (Applications__c) into the dashboard. Reads scripts/applications-backfill-data.json
// and POSTs each to /api/marketing/applications/ingest — the same endpoint the live
// Zap uses — then calls /applications/reconcile with the full id list so any
// application no longer in Salesforce is removed (no upward drift).
//
// Idempotent: the endpoint upserts per application id, so re-running is safe and
// safe to run alongside the live Zap.
//
// Needs network egress to the Railway app. Node 18+ (built-in fetch), no npm install.
//   INGEST_URL="https://loe-generator-production.up.railway.app/api/marketing/applications/ingest" \
//   ZAPIER_WEBHOOK_SECRET="<same secret set on the loe-generator Railway service>" \
//   node scripts/backfill-applications.js
//
// Refresh the data file anytime by re-running this SOQL and saving the rows:
//   SELECT Id, Account__r.Name, Grant_Program__c, State__c, Applicaiton_Status__c,
//          Total_Amount_Requested__c, Actual_Amount_Awarded__c, Maximum_Award_Amount__c
//   FROM Applications__c

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const INGEST_URL = process.env.INGEST_URL
  || 'https://loe-generator-production.up.railway.app/api/marketing/applications/ingest';
const RECONCILE_URL = process.env.RECONCILE_URL || INGEST_URL.replace(/\/ingest$/, '/reconcile');
const SECRET = process.env.ZAPIER_WEBHOOK_SECRET || '';
if (!SECRET) {
  console.error('Set ZAPIER_WEBHOOK_SECRET (same value as the loe-generator Railway service).');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(await readFile(path.join(__dirname, 'applications-backfill-data.json'), 'utf8'));

let ok = 0, failed = 0;
for (const r of rows) {
  const body = {
    application_id: r.id,
    organization: r.org || null,
    grant_program: r.program || null,
    state: r.state || null,
    status: r.status || null,
    amount_requested: r.requested ?? 0,
    amount_awarded: r.awarded ?? 0,
    max_award: r.max ?? 0,
  };
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-zap-secret': SECRET },
      body: JSON.stringify(body),
    });
    if (!res.ok) { failed++; console.error('HTTP', res.status, body.organization); continue; }
    await res.json();
    ok++;
  } catch (e) {
    failed++;
    console.error('error', body.organization, e.message);
  }
  await new Promise((res) => setTimeout(res, 50)); // gentle pace
}

console.log(`\nApplications loaded. ok: ${ok}, failed: ${failed} (of ${rows.length})`);

// Reconcile: drop anything no longer in Salesforce.
try {
  const res = await fetch(RECONCILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-zap-secret': SECRET },
    body: JSON.stringify({ application_ids: rows.map((r) => r.id) }),
  });
  if (!res.ok) {
    console.error(`Reconcile failed: HTTP ${res.status}. sf_applications may still contain stale rows.`);
  } else {
    const j = await res.json();
    console.log(`Reconcile complete. kept: ${j.kept}, removed: ${j.removed}`);
  }
} catch (e) {
  console.error('Reconcile error:', e.message);
}
