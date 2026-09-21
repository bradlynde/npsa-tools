/**
 * Smoke test for the deadlines adapter (server/gk-deadlines.js) and the
 * stage-aware deadline section (renderDeadlines in server/nsgp-deadlines.js).
 *
 * Run:  node scripts/gk-deadlines-smoke.mjs
 *
 * No database, no network. What it proves:
 *
 *   1. The seed, read through the adapter, gives rows in the old table's shape:
 *      Texas's two FY2026 stages as two rows with their time and zone, Colorado's
 *      NSGP-S and NSGP-UA deadline as one row, FEMA's date as kind "fema".
 *   2. "confirmed" means a person verified the date as it stands: an unverified
 *      record, or a verified one whose date was edited since, reads as recorded.
 *   3. Archiving a deadline, or the cycle it hangs on, takes it out.
 *   4. The fallback: an unreadable or empty knowledge base serves the old table,
 *      and says so.
 *   5. The section: stages in order, "next" measured on the deadline's own clock,
 *      the stages after it following, and rows from the old table rendering the
 *      federal lines exactly as the old renderer did.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { registerGrantKnowledge, createMemoryKnowledgeStore } from '../server/grant-knowledge.js';
import { deadlineRowsFromKnowledge, createDeadlineSource } from '../server/gk-deadlines.js';
import { renderDeadlines } from '../server/nsgp-deadlines.js';

process.env.MCP_API_KEYS = 'team-key';
delete process.env.ACTOR_PROXY_KEYS;

let failures = 0;
async function check(name, fn) {
  const log = console.log; console.log = () => {};
  try { await fn(); console.log = log; console.log(`PASS  ${name}`); }
  catch (err) { console.log = log; failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// A store with the real routes in front of it, so records are made the way the
// tab and the MCP make them.
async function knowledgeBase(now) {
  const store = createMemoryKnowledgeStore({ now });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  registerGrantKnowledge(app, { store, internalKey: 'internal', now });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/grant-knowledge`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer team-key', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data.error}`);
    return data;
  };
  return { store, call, close: () => server.close() };
}

const clock = new Date('2026-09-21T15:00:00Z');
const now = () => new Date(clock);

// ── 1. The seed through the adapter ───────────────────────────────────────────

await check('the seed reads back in the old shape, with stages, times and zones alongside', async () => {
  const kb = await knowledgeBase(now);
  const { records } = JSON.parse(readFileSync(new URL('../server/grant-knowledge-seed.json', import.meta.url), 'utf8'));
  await kb.call('POST', '/import', { records });
  const rows = deadlineRowsFromKnowledge(await kb.store.listRecords(), now());
  kb.close();

  for (const r of rows) {
    for (const f of ['id', 'state', 'program', 'cycle_year', 'deadline', 'kind', 'note', 'source', 'confidence', 'layer']) assert.ok(f in r, `${f} on every row`);
    assert.match(r.deadline, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['confirmed', 'illustrative'].includes(r.confidence));
  }

  const tx = rows.filter(r => r.state === 'TX' && r.program === 'federal' && r.cycle_year === 2026);
  assert.deepEqual(tx.map(r => [r.deadline, r.due_time, r.tz]), [['2026-02-12', '17:00', 'America/Chicago'], ['2026-07-06', '17:00', 'America/Chicago']]);
  assert.ok(tx[0].stage_order < tx[1].stage_order, 'stages in their own order');

  const co = rows.filter(r => r.state === 'CO' && r.program === 'federal' && r.cycle_year === 2026);
  assert.equal(co.length, 1, 'NSGP-S and NSGP-UA on the same day are one line');
  assert.deepEqual(co[0].program_keys.sort(), ['NSGP-S', 'NSGP-UA']);
  assert.equal(co[0].due_time, '23:59', 'the time one of them had is kept');

  const fema = rows.find(r => r.state === 'US' && r.cycle_year === 2026);
  assert.equal(fema.kind, 'fema');
  assert.equal(rows.find(r => r.state === 'AL' && r.program === 'federal' && r.cycle_year === 2026).deadline, '2026-07-15', 'the ruled Alabama date');
});

// ── 2–3. Trust and archive ────────────────────────────────────────────────────

let kb, deadline, cycle;
await check('"confirmed" needs a person behind the date as it stands', async () => {
  kb = await knowledgeBase(now);
  await kb.call('POST', '/records', { jurisdiction: 'KY', kind: 'jurisdiction', data: { saa: 'Kentucky Office of Homeland Security', saa_short: 'KOHS', default_tz: 'America/New_York' } });
  const program = await kb.call('POST', '/records', { jurisdiction: 'KY', kind: 'program', key: 'NSGP-S', data: { name: 'NSGP State', type: 'federal' } });
  cycle = await kb.call('POST', '/records', { jurisdiction: 'KY', kind: 'cycle', parent_id: program.id, data: { fiscal_year: 2027 } });
  deadline = await kb.call('POST', '/records', { jurisdiction: 'KY', kind: 'deadline', parent_id: cycle.id, data: { label: 'Application due', due_date: '2027-01-15', due_time: '16:00', confidence: 'confirmed' }, source_url: 'https://homelandsecurity.ky.gov/nsgp' });

  const row = async () => (await createDeadlineSource({ store: kb.store, now }).forState('KY')).find(r => r.record_id === deadline.id);
  assert.equal((await row()).confidence, 'illustrative', 'nobody has verified it');
  assert.equal((await row()).tz, 'America/New_York', 'the zone comes from the state when the deadline names none');

  deadline = await kb.call('POST', `/records/${deadline.id}/verify`, { version: deadline.version });
  assert.equal((await row()).confidence, 'confirmed');

  deadline = await kb.call('PATCH', `/records/${deadline.id}`, { version: deadline.version, data: { due_date: '2027-01-22' } });
  const moved = await row();
  assert.equal(moved.deadline, '2027-01-22');
  assert.equal(moved.confidence, 'illustrative', 'the date moved after it was verified');

  deadline = await kb.call('PATCH', `/records/${deadline.id}`, { version: deadline.version, data: { note: 'Email the SAA first.' }, verify: true });
  assert.equal((await row()).confidence, 'confirmed');
});

await check('archiving the deadline, or the cycle it hangs on, takes it out', async () => {
  const source = createDeadlineSource({ store: kb.store, now });
  const ids = async () => (await source.forState('KY')).map(r => r.record_id);
  assert.ok((await ids()).includes(deadline.id));
  cycle = await kb.call('POST', `/records/${cycle.id}/archive`, { version: cycle.version });
  assert.ok(!(await ids()).includes(deadline.id));
  cycle = await kb.call('POST', `/records/${cycle.id}/restore`, { version: cycle.version });
  deadline = await kb.call('POST', `/records/${deadline.id}/archive`, { version: deadline.version });
  assert.ok(!(await ids()).includes(deadline.id));
  kb.close();
});

// ── 4. Fallback ───────────────────────────────────────────────────────────────

await check('an unreadable or empty knowledge base serves the old table and says so', async () => {
  const legacy = [{ id: 7, state: 'IL', program: 'federal', cycle_year: 2026, deadline: '2026-06-30', kind: 'sub_applicant', note: '', source: '', confidence: 'confirmed', layer: 'manual', updated_at: null }];
  const pool = { query: async () => ({ rows: legacy }) };
  const quiet = { error: () => {} };

  const broken = createDeadlineSource({ store: { listRecords: async () => { throw new Error('connection refused'); } }, pool, now, log: quiet });
  const a = await broken.list();
  assert.equal(a.source, 'legacy-table');
  assert.deepEqual(a.deadlines, legacy);
  assert.ok(a.reference.states, 'the reference still travels with it');
  assert.deepEqual(await broken.forState('IL'), legacy);

  const empty = createDeadlineSource({ store: createMemoryKnowledgeStore({ now }), pool, now });
  assert.equal((await empty.list()).source, 'legacy-table');

  const nothing = createDeadlineSource({ store: null, pool: null, now });
  await assert.rejects(nothing.list(), e => e.status === 503);
  assert.deepEqual(await nothing.forState('IL'), []);
});

// ── 5. The section ────────────────────────────────────────────────────────────

const zoned = (date, time) => ({ due_time: time, tz: 'America/Chicago', instant: new Date(`${date}T${time}:00-06:00`).toISOString() });
const TX27 = [
  { state: 'TX', program: 'federal', cycle_year: 2027, deadline: '2027-02-11', confidence: 'confirmed', stage_order: 1, stage_label: 'Stage 1: eGrants application certified', note: '', ...zoned('2027-02-11', '17:00') },
  { state: 'TX', program: 'federal', cycle_year: 2027, deadline: '2027-07-06', confidence: 'illustrative', stage_order: 2, stage_label: 'Stage 2: IJ uploaded', note: '', ...zoned('2027-07-06', '17:00') },
  { state: 'US', program: 'federal', cycle_year: 2027, deadline: '2027-07-23', confidence: 'confirmed', stage_order: 1, stage_label: 'SAA applications due to FEMA', note: '' },
];
const at = iso => ({ state: 'TX', saaName: 'the Office of the Governor', todayIso: iso.slice(0, 10), now: new Date(iso) });

await check('a staged cycle lists its stages in order, and "next" is followed by the stage after it', async () => {
  const out = renderDeadlines(TX27, at('2027-01-05T15:00:00Z'));
  assert.match(out, /FY2027 — Stage 1: eGrants application certified by February 11, 2027 \(open\), then Stage 2: IJ uploaded by July 6, 2027 \(open\)\./);
  assert.match(out, /Next deadline: \*\*Stage 1: eGrants application certified by February 11, 2027, 5:00 PM CT\*\* \(FY2027, confirmed\)\. Then: Stage 2: IJ uploaded by July 6, 2027, 5:00 PM CT\./);
  assert.match(out, /Federal \(FEMA-to-SAA\) dates on record: FY2027 — July 23, 2027\./, 'the FEMA line needs no stage label');
});

await check('"next" is measured on the deadline\'s own clock: 4:59 PM in Austin is still open, 5:01 is not', async () => {
  const before = renderDeadlines(TX27, at('2027-02-11T22:59:00Z'));
  assert.match(before, /Next deadline: \*\*Stage 1/);
  const after = renderDeadlines(TX27, at('2027-02-11T23:01:00Z'));
  assert.match(after, /Next deadline: \*\*Stage 2: IJ uploaded by July 6, 2027, 5:00 PM CT\*\* \(FY2027, recorded — confirm before relying on it\)\./);
  assert.doesNotMatch(after, /Then:/);
});

await check('rows from the old table render the federal lines exactly as the old renderer did', async () => {
  const rows = [
    { state: 'KY', program: 'federal', cycle_year: 2026, deadline: '2026-07-13', kind: 'sub_applicant', note: '', confidence: 'confirmed' },
    { state: 'KY', program: 'federal', cycle_year: 2025, deadline: '2026-01-16', kind: 'sub_applicant', note: '', confidence: 'confirmed' },
    { state: 'US', program: 'federal', cycle_year: 2026, deadline: '2026-07-24', kind: 'fema', note: '', confidence: 'confirmed' },
  ];
  // Captured from the renderer this one replaced, on the same rows and day.
  const OLD = '- Recorded KY sub-applicant deadlines: FY2026 — July 13, 2026; FY2025 — January 16, 2026.\n'
    + '- The FY2026 window has closed. Next window: ~July 2027 (projected from 2 recorded cycles) — confirm with KOHS.\n'
    + '- Federal (FEMA-to-SAA) dates on record: FY2026 — July 24, 2026. Sub-applicant deadlines are earlier than these.';
  assert.equal(renderDeadlines(rows, { state: 'KY', saaName: 'KOHS', todayIso: '2026-09-21' }), OLD);
});

await check('a state program keeps its own track, and a state with nothing says so', async () => {
  const rows = [{ state: 'NJ', program: 'NJ-NSGP-THE', cycle_year: 2027, deadline: '2027-09-10', confidence: 'illustrative', note: 'Portal opens in August.' }];
  const out = renderDeadlines(rows, { state: 'NJ', saaName: 'NJOHSP', todayIso: '2027-03-01' });
  assert.match(out, /No NJ sub-applicant deadlines are recorded yet — confirm with NJOHSP\. \(Add them in the Grant Knowledge tab/);
  assert.match(out, /\*\*NJ-NSGP-THE:\*\* FY2027 — September 10, 2027 \(open\)\. Next: \*\*September 10, 2027\*\* \(FY2027, recorded — confirm before relying on it\)\. Portal opens in August\./);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll deadline checks passed');
process.exit(failures ? 1 : 0);
