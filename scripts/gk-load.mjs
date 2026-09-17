/**
 * Loads server/grant-knowledge-seed.json into the knowledge base through its API.
 *
 * Run:  NPSA_API_KEY=… node scripts/gk-load.mjs [--base https://…] [--apply] [--only TX,NY]
 *
 * Without --apply it is a dry run: it reports what would be created, updated and
 * skipped, and writes nothing. One jurisdiction per request, US first, so a parent
 * is always in before its children and no request outgrows the body limit. Safe to
 * run again: records nobody has touched are brought up to the bundle, records a
 * person or Claude has edited are left alone and listed.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const BASE = (arg('--base') || process.env.NPSA_API_BASE || 'https://loe-generator-production.up.railway.app').replace(/\/$/, '');
const KEY = process.env.NPSA_API_KEY || '';
const APPLY = args.includes('--apply');
const ONLY = arg('--only') ? new Set(arg('--only').toUpperCase().split(',')) : null;
const FILE = arg('--file') || new URL('../server/grant-knowledge-seed.json', import.meta.url).pathname;
if (!KEY) { console.error('Set NPSA_API_KEY to a key from MCP_API_KEYS.'); process.exit(2); }

const { records } = JSON.parse(readFileSync(FILE, 'utf8'));
const codes = [...new Set(records.map(r => r.jurisdiction))].filter(c => !ONLY || ONLY.has(c)).sort((a, b) => (a === 'US' ? -1 : b === 'US' ? 1 : a.localeCompare(b)));
const total = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };

console.log(`${APPLY ? 'LOADING' : 'Dry run of'} ${records.length} records for ${codes.length} jurisdictions → ${BASE}`);
for (const code of codes) {
  const r = await fetch(`${BASE}/api/grant-knowledge/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ dry_run: !APPLY, records: records.filter(x => x.jurisdiction === code) }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${code}: HTTP ${r.status} ${out.error || ''}`); process.exit(1); }
  console.log(`${code}  +${out.created}  ~${out.updated}  =${out.unchanged}  skipped ${out.skipped.length}  errors ${out.errors.length}`);
  for (const s of out.skipped) console.log(`      skipped ${s.import_key}: ${s.why}`);
  for (const e of out.errors) console.log(`      ERROR   ${e.import_key}: ${e.error}`);
  total.created += out.created; total.updated += out.updated; total.unchanged += out.unchanged; total.skipped += out.skipped.length; total.errors += out.errors.length;
}
console.log(`\n${APPLY ? 'Loaded' : 'Would load'}: ${total.created} created, ${total.updated} updated, ${total.unchanged} unchanged, ${total.skipped} skipped, ${total.errors} errors`);
if (!APPLY) console.log('Nothing was written. Add --apply to load.');
process.exit(total.errors ? 1 : 0);
