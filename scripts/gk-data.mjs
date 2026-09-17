/**
 * Integrity check for server/grant-knowledge-seed.json.
 *
 * Run:  node scripts/gk-data.mjs
 *
 * Shape, not content: it cannot know whether Ohio's deadline is right, but it can
 * know that every jurisdiction is there, every record fits its schema and hangs on
 * a parent that exists, every deadline names a real date in a real zone, and that
 * loading the bundle twice changes nothing. A malformed row here is not a crash,
 * it is a confidently wrong line on a state page.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { JURISDICTION_CODES, PARENT_KINDS, parseData, validTimeZone } from '../server/grant-knowledge-kinds.js';
import { registerGrantKnowledge, createMemoryKnowledgeStore } from '../server/grant-knowledge.js';

const { records } = JSON.parse(readFileSync(new URL('../server/grant-knowledge-seed.json', import.meta.url), 'utf8'));
const byKey = new Map(records.map(r => [r.import_key, r]));
let failures = 0;
async function check(name, fn) {
  const log = console.log; console.log = () => {};
  try { await fn(); console.log = log; console.log(`PASS  ${name}`); }
  catch (err) { console.log = log; failures++; console.log(`FAIL  ${name}\n      ${String(err.message).slice(0, 600)}`); }
}

await check('all 57 jurisdictions are present, each with an SAA and at least one federal program', () => {
  for (const code of JURISDICTION_CODES) {
    const j = byKey.get(`j:${code}`);
    assert.ok(j, `${code} has no jurisdiction record`);
    assert.ok(j.data.saa, `${code} has no SAA`);
    assert.ok(j.data.default_tz && validTimeZone(j.data.default_tz), `${code} has no default zone`);
    assert.ok(records.some(r => r.jurisdiction === code && r.kind === 'program' && r.data.type === 'federal'), `${code} has no federal program`);
  }
});
await check('import keys are unique, and every natural key is unique where it hangs', () => {
  assert.equal(byKey.size, records.length);
  const natural = new Set();
  for (const r of records) { const k = `${r.jurisdiction}|${r.kind}|${r.parent || ''}|${r.key}`; assert.ok(!natural.has(k), `duplicate ${k}`); natural.add(k); }
});
await check('every record fits its schema, and hangs on a parent of the right kind that comes before it', () => {
  const seen = new Set();
  for (const r of records) {
    parseData(r.kind, r.data);
    const parent = r.parent ? byKey.get(r.parent) : null;
    if (r.parent) { assert.ok(parent, `${r.import_key}: parent ${r.parent} missing`); assert.ok(seen.has(r.parent), `${r.import_key} comes before its parent`); assert.equal(parent.jurisdiction, r.jurisdiction); }
    assert.ok(PARENT_KINDS[r.kind].includes(parent ? parent.kind : null), `${r.import_key}: a ${r.kind} cannot hang under ${parent ? parent.kind : 'nothing'}`);
    seen.add(r.import_key);
  }
});
await check('every deadline is a real date in a real zone under a cycle; every verified record says who verified it', () => {
  for (const r of records) {
    if (r.kind === 'deadline') { assert.ok(!Number.isNaN(Date.parse(r.data.due_date)), r.import_key); assert.ok(validTimeZone(r.data.tz), `${r.import_key}: zone`); }
    if (r.status === 'verified') assert.ok(r.verified_by && r.verified_at, `${r.import_key}: verified with no verifier`);
    else assert.equal(r.verified_at, null);
  }
});
await check('caps are numbers, stackable is true, false or "verify", and exclusive_with names a real sibling', () => {
  for (const p of records.filter(r => r.kind === 'program')) {
    for (const f of ['cap_per_location', 'cap_per_applicant', 'locations_max', 'ma_pct']) assert.ok(p.data[f] === undefined || typeof p.data[f] === 'number', `${p.import_key}.${f}`);
    assert.ok([undefined, true, false, 'verify'].includes(p.data.stackable), `${p.import_key}.stackable`);
    for (const x of p.data.exclusive_with || []) assert.ok(byKey.has(`p:${p.jurisdiction}:${x}`), `${p.import_key} excludes ${x}, which is not a program there`);
    if (p.data.inherits_from) assert.ok(byKey.has(`p:${p.jurisdiction}:${p.data.inherits_from}`), `${p.import_key} inherits from nothing`);
  }
});
await check('named regressions: Texas is PSO with two stages, NJ state programs exclude each other, the federal baseline has five lines', () => {
  assert.match(byKey.get('j:TX').data.saa, /Public Safety Office/);
  assert.ok(!/TDEM/.test(byKey.get('p:TX:NSGP-S').data.administered_by));
  const txStages = records.filter(r => r.parent === 'c:TX:NSGP-S:2026' && r.kind === 'deadline').sort((a, b) => a.data.stage_order - b.data.stage_order);
  assert.deepEqual(txStages.map(d => [d.data.due_date, d.data.deadline_kind, d.status]), [['2026-02-12', 'stage', 'verified'], ['2026-07-06', 'stage', 'verified']], 'Texas FY26: Stage 1 2/12 (ruled 2026-09-17), Stage 2 7/6, and nothing else');
  assert.ok(!records.some(r => r.jurisdiction === 'TX' && JSON.stringify(r.data).includes('3/12/2026')), 'no Texas record still says 3/12');
  assert.match(byKey.get('r:KY:NSGP-S:eclearinghouse_reg').data.label, /DLG Portal/); assert.equal(byKey.get('r:KY:NSGP-S:eclearinghouse_reg').data.hard_gate, true);
  assert.equal(byKey.get('d:AL:NSGP-S:2026:final').data.due_date, '2026-07-15'); assert.ok(!records.some(r => r.jurisdiction === 'AL' && r.data.due_date === '2026-07-16'));
  assert.equal(byKey.get('c:AZ:AZ-NSGP:2026').key, '2027');
  assert.deepEqual(records.filter(r => r.kind === 'deadline' && r.import_key.startsWith('d:TN:TN-HOW:') && r.data.due_date.startsWith('2026')).map(r => r.data.due_date), ['2026-07-29']);
  assert.deepEqual(byKey.get('p:NJ:NJ-NSGP-THE').data.exclusive_with, ['NJ-NSGP-SP']);
  assert.equal(byKey.get('p:FL:FL-NSGP').data.status, 'dormant');
  assert.equal(records.filter(r => r.parent === 'p:US:NSGP' && r.kind === 'requirement').length, 5);
  assert.equal(byKey.get('d:NY:SCAHC:2026:final').data.due_time, '12:00');
  assert.equal(byKey.get('d:LA:NSGP-S:2026:final').data.tz, 'America/Chicago');
});

// Load it for real, against the routes, twice.
process.env.MCP_API_KEYS = 'k'; delete process.env.ACTOR_PROXY_KEYS; delete process.env.MCP_KEY_NAMES;
const store = createMemoryKnowledgeStore();
const app = express(); app.use(express.json({ limit: '20mb' }));
registerGrantKnowledge(app, { store, internalKey: 'i', now: () => new Date('2026-09-17T15:00:00Z') });
const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
const G = `http://127.0.0.1:${server.address().port}/api/grant-knowledge`;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer k' };
const load = (body) => fetch(`${G}/import`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(r => r.json());

await check('a dry run writes nothing; the load creates every record; a second load changes nothing', async () => {
  const dry = await load({ records, dry_run: true });
  assert.equal(dry.created, records.length); assert.deepEqual(dry.errors, []); assert.equal(store._records.length, 0);
  const first = await load({ records });
  assert.deepEqual(first.errors, []); assert.equal(first.created, records.length); assert.equal(store._revisions.length, records.length);
  assert.ok(store._revisions.every(v => v.action === 'import' && v.actor_kind === 'import'));
  const second = await load({ records });
  assert.equal(second.unchanged, records.length); assert.equal(second.created + second.updated + second.skipped.length, 0);
  assert.equal(store._revisions.length, records.length, 'no revision for an unchanged record');
});
await check('a record a person has edited is left alone; an untouched one is brought up to the bundle', async () => {
  const tx = store._records.find(r => r.import_key === 'j:TX');
  const edit = await fetch(`${G}/records/${tx.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ version: tx.version, data: { saa_short: 'PSO' } }) }).then(r => r.json());
  assert.equal(edit.data.saa_short, 'PSO');
  const changed = records.map(r => (r.import_key === 'j:TX' || r.import_key === 'j:NY' ? { ...r, data: { ...r.data, cycle_status: 'changed in the bundle' } } : r));
  const third = await load({ records: changed });
  assert.equal(third.updated, 1); assert.equal(third.skipped.length, 1); assert.match(third.skipped[0].why, /edited since the import/);
  assert.equal(store._records.find(r => r.import_key === 'j:TX').data.saa_short, 'PSO');
  assert.equal(store._records.find(r => r.import_key === 'j:NY').data.cycle_status, 'changed in the bundle');
});
await check('the loaded base assembles: 57 overview rows, Texas reads as two stages, the export round-trips', async () => {
  const o = (await fetch(`${G}/overview`, { headers: H }).then(r => r.json())).jurisdictions;
  assert.equal(o.length, 57); assert.ok(o.every(x => x.saa), 'every row has an SAA');
  assert.ok(o.filter(x => x.has_state_program).length >= 15);
  const tx = await fetch(`${G}/jurisdictions/TX`, { headers: H }).then(r => r.json());
  assert.equal(tx.programs[1].data.inherits_from, 'NSGP-S');
  assert.ok(tx.programs[0].requirements.find(r => r.key === 'ij').baseline === 'federal', "Texas's IJ line stands in for the baseline one");
  assert.ok(!tx.programs[0].inherited_requirements.some(r => r.key === 'ij'));
  assert.equal(tx.cycle_state, 'closed');
  const ky = await fetch(`${G}/jurisdictions/KY`, { headers: H }).then(r => r.json());
  assert.ok(ky.open_questions >= 1, 'the clearinghouse-letter question is open');
  const ex = await fetch(`${G}/export`, { headers: H }).then(r => r.json());
  assert.equal(ex.records.length, records.length);
  const again = await load({ records: ex.records.filter(r => r.jurisdiction === 'NJ') });
  assert.equal(again.created, 0); assert.deepEqual(again.errors, []);
});

server.close();
const n = k => records.filter(r => r.kind === k).length;
console.log(`\n${records.length} records · ${n('program')} programs · ${n('requirement')} requirements · ${n('deadline')} deadlines · ${n('contact')} contacts · ${n('note')} notes · ${records.filter(r => r.status === 'verified').length} verified`);
console.log(failures ? `${failures} check(s) failed` : 'All seed checks passed');
process.exit(failures ? 1 : 0);
