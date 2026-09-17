/**
 * Smoke test for the grant knowledge routes (server/grant-knowledge.js).
 *
 * Run:  node scripts/gk-smoke.mjs
 *
 * No database and no network: the routes run against the in-memory store on an
 * ephemeral port, with the clock injected so "in 30 days" and "a year old" mean
 * the same thing on every run. What it proves:
 *
 *   1. The gate. Team routes refuse without a key and fail closed with none set.
 *   2. Shape. A record is refused with the bad field named: an unknown field, a
 *      bad zone, a deadline hung on a program, a jurisdiction that is not one.
 *   3. History. Every write lands exactly one revision with before and after; a
 *      no-op lands none.
 *   4. Concurrency. A write against an old version is a 409 carrying the current
 *      record, and nothing is written.
 *   5. Trust. New records are unverified; editing a verified record flags only the
 *      fields that moved; verify clears them; Claude cannot verify inline and must
 *      say where a fact came from; old verification reads as stale.
 *   6. Revert, of an edit and of a create; archive takes children out of view.
 *   7. Assembly: federal baseline + state-added requirements, inheritance, hard
 *      gates first, staged deadlines, the cycle state, and time zones at the edge.
 *   8. Search, needs-attention, overview (57 rows always), bulk verify.
 *   9. Who: X-Actor from a proxy key is the actor and the actor_kind is user.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { registerGrantKnowledge, createMemoryKnowledgeStore, zonedInstant } from '../server/grant-knowledge.js';
import { fingerprint } from '../server/mcp.js';

const INTERNAL = 'boot-secret-for-test';
process.env.MCP_API_KEYS = 'team-key-one, vercel-key';
process.env.ACTOR_PROXY_KEYS = fingerprint('vercel-key');
delete process.env.MCP_KEY_NAMES;

let clock = new Date('2026-09-17T15:00:00Z');
const now = () => new Date(clock);
const store = createMemoryKnowledgeStore({ now });
const app = express();
app.use(express.json({ limit: '2mb' }));
registerGrantKnowledge(app, { store, internalKey: INTERNAL, now });
const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;

const WEB = { Authorization: 'Bearer vercel-key', 'X-Actor': 'Stuart' };
const BRAD = { Authorization: 'Bearer vercel-key', 'X-Actor': 'Brad' };
const CLAUDE = { 'X-Internal-Key': INTERNAL, 'X-Actor': 'Stuart' };
const G = '/api/grant-knowledge';
async function call(method, path, { headers = WEB, body } = {}) {
  const r = await fetch(origin + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const create = async (body, headers = WEB) => {
  const r = await call('POST', `${G}/records`, { headers, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const revisionsOf = async id => (await call('GET', `${G}/records/${id}/revisions`)).data.revisions;

let failures = 0;
async function check(name, fn) {
  const log = console.log; console.log = () => {};
  try { await fn(); console.log = log; console.log(`PASS  ${name}`); }
  catch (err) { console.log = log; failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// ── 1. Gate ───────────────────────────────────────────────────────────────────
await check('no key is 401, a wrong key is 401, and with no keys configured only the internal key gets in', async () => {
  assert.equal((await call('GET', `${G}/overview`, { headers: {} })).status, 401);
  assert.equal((await call('GET', `${G}/overview`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const saved = process.env.MCP_API_KEYS; delete process.env.MCP_API_KEYS;
  try {
    assert.equal((await call('GET', `${G}/overview`)).status, 401);
    assert.equal((await call('GET', `${G}/overview`, { headers: CLAUDE })).status, 200);
  } finally { process.env.MCP_API_KEYS = saved; }
});
await check('with no store every route is 503', async () => {
  const bare = express(); bare.use(express.json());
  registerGrantKnowledge(bare, { store: null, internalKey: INTERNAL });
  const s = await new Promise(resolve => { const x = bare.listen(0, () => resolve(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}${G}/overview`, { headers: WEB });
    assert.equal(r.status, 503);
  } finally { s.close(); }
});

// ── 2. Shape ──────────────────────────────────────────────────────────────────
let tx, us, usProgram, nsgpS, nsgpUA;
await check('a jurisdiction record takes its code as its key; a second one is a 409 naming the first', async () => {
  tx = await create({ jurisdiction: 'tx', kind: 'jurisdiction', data: { saa: 'Office of the Governor, Public Safety Office', saa_short: 'OOG PSO', default_tz: 'America/Chicago' } });
  assert.equal(tx.key, 'TX'); assert.equal(tx.jurisdiction, 'TX'); assert.equal(tx.title, 'Texas');
  assert.equal(tx.status, 'unverified'); assert.equal(tx.origin, 'manual'); assert.equal(tx.version, 1); assert.equal(tx.created_by, 'Stuart');
  const again = await call('POST', `${G}/records`, { body: { jurisdiction: 'TX', kind: 'jurisdiction', data: {} } });
  assert.equal(again.status, 409); assert.equal(again.data.existing.id, tx.id);
});
await check('bad input is refused with the field named', async () => {
  const post = body => call('POST', `${G}/records`, { body });
  assert.match((await post({ jurisdiction: 'ZZ', kind: 'jurisdiction', data: {} })).data.error, /USPS/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'widget', data: {} })).data.error, /kind must be/);
  const typo = await post({ jurisdiction: 'TX', kind: 'program', key: 'X', data: { name: 'X', type: 'federal', cap_per_site: 1 } });
  assert.equal(typo.status, 400); assert.match(typo.data.error, /unknown field\(s\) cap_per_site/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'program', data: { name: 'No key', type: 'state' } })).data.error, /needs a key/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'requirement', data: { req_type: 'document', label: 'IJ' } })).data.error, /hangs under: program/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'contact', data: {} })).data.error, /needs at least/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'source', data: { url: 'ftp://x' } })).data.error, /http/);
  assert.match((await post({ jurisdiction: 'TX', kind: 'source', data: { url: 'https://x.gov' }, source_url: 'javascript:alert(1)' })).data.error, /source_url/);
});

// ── 3–5. Programs, history, concurrency, trust ────────────────────────────────
await check('programs, requirements, cycles and staged deadlines hang where they should', async () => {
  us = await create({ jurisdiction: 'US', kind: 'jurisdiction', data: { ij_form: { number: 'FF-207-FY-21-115' } } });
  usProgram = await create({ jurisdiction: 'US', kind: 'program', key: 'NSGP', data: { name: 'Nonprofit Security Grant Program', type: 'federal', cap_per_location: 200000, ma_pct: 5, locations_max: 3 } });
  for (const [label, extra] of [['Investment Justification', { format: 'FEMA fillable PDF, never flattened' }], ['Mission statement on letterhead', {}]]) {
    await create({ jurisdiction: 'US', kind: 'requirement', parent_id: usProgram.id, data: { req_type: 'document', label, owner: 'client', ...extra } });
  }
  await create({ jurisdiction: 'US', kind: 'requirement', parent_id: usProgram.id, data: { req_type: 'registration', label: 'SAM.gov / UEI', owner: 'client', hard_gate: true, lead_time_days: 30 } });

  nsgpS = await create({ jurisdiction: 'TX', kind: 'program', key: 'NSGP-S', data: { name: 'NSGP State', type: 'federal', submission: { method: 'portal', platform: 'eGrants', url: 'https://egrants.gov.texas.gov' } } });
  nsgpUA = await create({ jurisdiction: 'TX', kind: 'program', key: 'NSGP-UA', sort_order: 1, data: { name: 'NSGP Urban Area', type: 'federal', inherits_from: 'NSGP-S' } });
  await create({ jurisdiction: 'TX', kind: 'requirement', parent_id: nsgpS.id, data: { req_type: 'document', label: 'Governing body resolution', owner: 'client' } });
  await create({ jurisdiction: 'TX', kind: 'requirement', parent_id: nsgpS.id, data: { req_type: 'registration', label: 'eGrants account and Payee ID', owner: 'client', hard_gate: true, lead_time_days: 45 } });
  await create({ jurisdiction: 'TX', kind: 'requirement', parent_id: nsgpS.id, data: { req_type: 'registration', label: 'Asana project', owner: 'npsa' } });

  const wrongParent = await call('POST', `${G}/records`, { body: { jurisdiction: 'TX', kind: 'deadline', parent_id: nsgpS.id, data: { label: 'Final', due_date: '2026-07-06' } } });
  assert.match(wrongParent.data.error, /hangs under: cycle/);
  const otherState = await call('POST', `${G}/records`, { body: { jurisdiction: 'NY', kind: 'cycle', parent_id: nsgpS.id, data: { fiscal_year: 2026 } } });
  assert.match(otherState.data.error, /not a record in NY/);

  const fy27 = await create({ jurisdiction: 'TX', kind: 'cycle', parent_id: nsgpS.id, data: { fiscal_year: 2027, status: 'pre_nofo', open_date: '2027-01-12' } });
  assert.equal(fy27.key, '2027');
  await create({ jurisdiction: 'TX', kind: 'deadline', parent_id: fy27.id, data: { label: 'Stage 1: certify in eGrants', stage_order: 1, due_date: '2027-03-12', due_time: '17:00', deadline_kind: 'stage', confidence: 'projected' } });
  await create({ jurisdiction: 'TX', kind: 'deadline', parent_id: fy27.id, data: { label: 'Stage 2: upload documents', stage_order: 2, due_date: '2027-07-06', due_time: '17:00', deadline_kind: 'stage', confidence: 'projected' } });
  const fy26 = await create({ jurisdiction: 'TX', kind: 'cycle', parent_id: nsgpS.id, data: { fiscal_year: 2026, status: 'closed', state_allocation: 12000000 } });
  await create({ jurisdiction: 'TX', kind: 'deadline', parent_id: fy26.id, data: { label: 'Stage 2: upload documents', due_date: '2026-07-06', due_time: '17:00' } });
});

await check('every write is one revision with before and after; a no-op is none', async () => {
  let revs = await revisionsOf(tx.id);
  assert.equal(revs.length, 1); assert.equal(revs[0].action, 'create'); assert.equal(revs[0].before, null);
  assert.equal(revs[0].actor, 'Stuart'); assert.equal(revs[0].actor_kind, 'user');
  const r = await call('PATCH', `${G}/records/${tx.id}`, { body: { version: 1, data: { saa_url: 'https://gov.texas.gov/organization/cjd' }, reason: 'added the PSO page' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.version, 2);
  revs = await revisionsOf(tx.id);
  assert.equal(revs.length, 2);
  assert.deepEqual(revs[0].changed_fields, ['saa_url']); assert.equal(revs[0].reason, 'added the PSO page');
  assert.equal(revs[0].before.data.saa_url, undefined); assert.equal(revs[0].after.data.saa_url, 'https://gov.texas.gov/organization/cjd');
  assert.equal(revs[0].version_from, 1); assert.equal(revs[0].version_to, 2);
  const noop = await call('PATCH', `${G}/records/${tx.id}`, { body: { version: 2, data: { saa_short: 'OOG PSO' } } });
  assert.equal(noop.data.version, 2);
  assert.equal((await revisionsOf(tx.id)).length, 2);
  tx = noop.data;
});

await check('a write against an old version is a 409 with the current record, and writes nothing', async () => {
  const stale = await call('PATCH', `${G}/records/${tx.id}`, { headers: BRAD, body: { version: 1, data: { saa_short: 'PSO' } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.current.version, 2); assert.equal(stale.data.current.data.saa_short, 'OOG PSO');
  assert.match(stale.data.error, /last edited by Stuart/);
  assert.equal((await call('PATCH', `${G}/records/${tx.id}`, { body: { data: { saa_short: 'PSO' } } })).status, 400, 'version is required');
  assert.equal((await revisionsOf(tx.id)).length, 2);
});

await check('verify, then an edit flags only the field that moved; null clears a field; verify again clears the flags', async () => {
  let r = await call('POST', `${G}/records/${tx.id}/verify`, { headers: BRAD, body: { version: tx.version } });
  assert.equal(r.data.status, 'verified'); assert.equal(r.data.verified_by, 'Brad'); assert.ok(r.data.verified_at);
  r = await call('PATCH', `${G}/records/${tx.id}`, { body: { version: r.data.version, data: { cycle_status: 'FY27 Stage 1 opens January', saa_url: null } } });
  assert.equal(r.data.status, 'verified');
  assert.deepEqual(r.data.unverified_fields, ['cycle_status'], 'a removed field cannot be flagged, a changed one is');
  assert.equal(r.data.data.saa_url, undefined);
  r = await call('PATCH', `${G}/records/${tx.id}`, { body: { version: r.data.version, data: { partner: 'none' }, verify: true } });
  assert.deepEqual(r.data.unverified_fields, []); assert.equal(r.data.verified_by, 'Stuart');
  tx = r.data;
});

await check('Claude must say where a fact came from, lands unverified, and cannot verify inline', async () => {
  const bare = await call('POST', `${G}/records`, { headers: CLAUDE, body: { jurisdiction: 'TX', kind: 'note', data: { category: 'gotcha', title: 'Miss Stage 1 and you are locked out' } } });
  assert.equal(bare.status, 400); assert.match(bare.data.error, /source_url, or a reason/);
  const n = await create({ jurisdiction: 'TX', kind: 'note', origin: 'research', verify: true, source_url: 'https://egrants.gov.texas.gov/fundingopp', data: { category: 'gotcha', severity: 'auto_disqualifier', title: 'Miss Stage 1 and you are locked out', phase: 'before_nofo' } }, CLAUDE);
  assert.equal(n.status, 'unverified'); assert.equal(n.origin, 'research'); assert.equal(n.key, 'miss-stage-1-and-you-are-locked-out');
  assert.equal((await revisionsOf(n.id))[0].actor_kind, 'mcp');
  const field = await create({ jurisdiction: 'TX', kind: 'note', reason: 'Stuart said so from the Greenland Hills engagement', data: { category: 'process', title: 'Three grant officials are required', client_slug: 'greenland-hills-umc' } }, CLAUDE);
  assert.equal(field.origin, 'mcp');
  const spoof = await create({ jurisdiction: 'TX', kind: 'note', origin: 'import', data: { category: 'history', title: 'Web cannot claim import' } });
  assert.equal(spoof.origin, 'manual');
  const edit = await call('PATCH', `${G}/records/${tx.id}`, { headers: CLAUDE, body: { version: tx.version, data: { partner: 'changed by Claude' } } });
  assert.equal(edit.status, 400, 'an MCP edit of data with no source and no reason');
});

await check('a verification more than a year old reads as stale, but a passed deadline never does', async () => {
  const past = (await call('GET', `${G}/jurisdictions/TX`)).data.programs[0].cycles.find(c => c.key === '2026').deadlines[0];
  await call('POST', `${G}/records/${past.id}/verify`, { body: { version: past.version } });
  const saved = clock; clock = new Date('2027-10-01T00:00:00Z');
  try {
    assert.equal((await call('GET', `${G}/records/${tx.id}`)).data.effective_status, 'stale');
    assert.equal((await call('GET', `${G}/records/${tx.id}`)).data.status, 'verified', 'stale is computed, never stored');
    assert.equal((await call('GET', `${G}/records/${past.id}`)).data.effective_status, 'verified');
    assert.ok((await call('GET', `${G}/needs-attention`)).data.stale.some(x => x.record_id === tx.id));
  } finally { clock = saved; }
});

// ── 6. Revert and archive ─────────────────────────────────────────────────────
await check('reverting an edit restores the old values as a new revision; reverting a create archives', async () => {
  const before = (await call('GET', `${G}/records/${nsgpS.id}`)).data;
  const edited = (await call('PATCH', `${G}/records/${nsgpS.id}`, { headers: BRAD, body: { version: before.version, data: { cap_per_location: 1 }, source_url: 'https://wrong.example' } })).data;
  const rev = (await revisionsOf(nsgpS.id))[0];
  const stale = await call('POST', `${G}/revisions/${rev.id}/revert`, { body: { version: before.version } });
  assert.equal(stale.status, 409);
  const back = await call('POST', `${G}/revisions/${rev.id}/revert`, { body: { version: edited.version } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.data.cap_per_location, undefined); assert.equal(back.data.source_url, ''); assert.equal(back.data.version, edited.version + 1);
  const top = (await revisionsOf(nsgpS.id))[0];
  assert.equal(top.action, 'revert'); assert.equal(top.reverted_revision_id, rev.id); assert.match(top.reason, /update by Brad/);

  const c = await create({ jurisdiction: 'TX', kind: 'contact', data: { name: 'Wrong Person', email: 'wrong@example.org' } });
  const gone = await call('POST', `${G}/revisions/${(await revisionsOf(c.id))[0].id}/revert`, { body: { version: c.version } });
  assert.ok(gone.data.archived_at);
  assert.ok(!(await call('GET', `${G}/jurisdictions/TX`)).data.contacts.some(x => x.id === c.id));
  assert.ok((await call('GET', `${G}/jurisdictions/TX?include_archived=1`)).data.archived.some(x => x.id === c.id));
  const dupe = await call('POST', `${G}/records`, { body: { jurisdiction: 'TX', kind: 'contact', key: 'wrong-person', data: { name: 'Wrong Person' } } });
  assert.equal(dupe.status, 409); assert.match(dupe.data.error, /archived; restore/);
});

await check('archiving a program takes its requirements and deadlines out of view; restore brings them back', async () => {
  const p = (await call('GET', `${G}/records/${nsgpS.id}`)).data;
  const a = await call('POST', `${G}/records/${p.id}/archive`, { body: { version: p.version } });
  assert.equal(a.status, 200);
  let doc = (await call('GET', `${G}/jurisdictions/TX`)).data;
  assert.deepEqual(doc.programs.map(x => x.key), ['NSGP-UA']);
  assert.equal(doc.cycle_state, 'unknown');
  assert.equal((await call('GET', `${G}/search?q=egrants payee`)).data.hits.length, 0, 'a hit under an archived program is not a hit');
  assert.equal((await call('PATCH', `${G}/records/${p.id}`, { body: { version: a.data.version, data: { ma_pct: 5 } } })).status, 409);
  await call('POST', `${G}/records/${p.id}/restore`, { body: { version: a.data.version } });
  doc = (await call('GET', `${G}/jurisdictions/TX`)).data;
  assert.deepEqual(doc.programs.map(x => x.key), ['NSGP-S', 'NSGP-UA']);
});

// ── 7. Assembly ───────────────────────────────────────────────────────────────
await check('the state document: federal baseline flagged, inheritance, staged deadlines, cycle state', async () => {
  const doc = (await call('GET', `${G}/jurisdictions/TX`)).data;
  assert.equal(doc.name, 'Texas'); assert.equal(doc.jurisdiction.data.saa_short, 'OOG PSO');
  const s = doc.programs[0], ua = doc.programs[1];
  assert.equal(s.inherited_requirements.length, 3); assert.ok(s.inherited_requirements.every(r => r.baseline === 'federal'));
  assert.equal(s.requirements.length, 3); assert.ok(s.requirements.every(r => r.baseline === 'state'));
  assert.equal(ua.requirements.length, 0);
  assert.equal(ua.inherited_requirements.filter(r => r.inherited_from === 'NSGP-S').length, 3);
  assert.deepEqual(s.cycles.map(c => c.key), ['2027', '2026'], 'newest cycle first');
  assert.deepEqual(s.cycles[0].deadlines.map(d => d.data.stage_order), [1, 2]);
  assert.equal(doc.cycle_state, 'soon', 'a deadline ahead but the window has not opened');
  assert.equal(doc.next_deadline.label, 'Stage 1: certify in eGrants');
  assert.equal(doc.next_deadline.tz, 'America/Chicago', 'falls back to the jurisdiction zone');
  assert.equal(doc.next_deadline.instant, '2027-03-12T23:00:00.000Z', '5pm CST (the clocks move two days later) is 23:00Z');
  assert.equal(doc.open_questions, 0);
  const usDoc = (await call('GET', `${G}/jurisdictions/US`)).data;
  assert.equal(usDoc.programs[0].inherited_requirements.length, 0, 'the baseline does not inherit from itself');
});

await check('the checklist puts hard gates and long lead times first and says who owns each line', async () => {
  const r = await call('GET', `${G}/jurisdictions/TX/requirements?program=nsgp-s`);
  assert.equal(r.status, 200);
  const reg = r.data.programs[0].registration;
  assert.deepEqual(reg.map(x => x.label), ['eGrants account and Payee ID', 'SAM.gov / UEI', 'Asana project']);
  assert.deepEqual(reg.map(x => x.owner), ['client', 'client', 'npsa']);
  assert.deepEqual(reg.map(x => x.baseline), ['state', 'federal', 'state']);
  assert.equal(r.data.programs[0].documents.length, 3);
  assert.equal(r.data.programs[0].documents[0].phase, 'application');
  const missing = await call('GET', `${G}/jurisdictions/TX/requirements?program=SCAHC`);
  assert.equal(missing.status, 404); assert.match(missing.data.error, /NSGP-S, NSGP-UA/);
});

await check('zonedInstant: standard and daylight time, no time means end of day there, and the day the clocks move', async () => {
  assert.equal(zonedInstant('2026-01-15', '16:00', 'America/Chicago').toISOString(), '2026-01-15T22:00:00.000Z');
  assert.equal(zonedInstant('2026-07-08', '12:00', 'America/New_York').toISOString(), '2026-07-08T16:00:00.000Z');
  assert.equal(zonedInstant('2026-06-30', null, 'Pacific/Guam').toISOString(), '2026-06-30T13:59:59.000Z');
  assert.equal(zonedInstant('2026-11-01', '23:55', 'America/Denver').toISOString(), '2026-11-02T06:55:00.000Z');
  assert.equal(zonedInstant('2026-03-08', '17:00', 'America/Chicago').toISOString(), '2026-03-08T22:00:00.000Z');
});

await check('a 4pm Central deadline is still ahead at 3:59 and behind at 4:01; an open window reads as open', async () => {
  const la = await create({ jurisdiction: 'LA', kind: 'jurisdiction', data: { default_tz: 'America/Chicago' } });
  const p = await create({ jurisdiction: 'LA', kind: 'program', key: 'NSGP-S', data: { name: 'NSGP State', type: 'federal' } });
  const c = await create({ jurisdiction: 'LA', kind: 'cycle', parent_id: p.id, data: { fiscal_year: 2026, open_date: '2026-09-01' } });
  await create({ jurisdiction: 'LA', kind: 'deadline', parent_id: c.id, data: { label: 'Application due', due_date: '2026-10-01', due_time: '16:00' } });
  const saved = clock;
  try {
    clock = new Date('2026-10-01T20:59:00Z');
    let doc = (await call('GET', `${G}/jurisdictions/LA`)).data;
    assert.equal(doc.cycle_state, 'open'); assert.equal(doc.next_deadline.days_away, 1);
    assert.equal((await call('GET', `${G}/needs-attention?days=1&state=LA`)).data.deadlines_soon.length, 1);
    clock = new Date('2026-10-01T21:01:00Z');
    doc = (await call('GET', `${G}/jurisdictions/LA`)).data;
    assert.equal(doc.cycle_state, 'closed'); assert.equal(doc.next_deadline, null);
  } finally { clock = saved; }
  assert.ok(la.id);
});

// ── 8. Search, attention, overview, bulk verify ───────────────────────────────
await check('search matches every term, across kinds, and can be narrowed', async () => {
  const hits = (await call('GET', `${G}/search?q=stage locked`)).data.hits;
  assert.equal(hits.length, 1); assert.equal(hits[0].kind, 'note'); assert.equal(hits[0].jurisdiction, 'TX'); assert.match(hits[0].snippet, /locked out/);
  assert.ok((await call('GET', `${G}/search?q=egrants`)).data.hits.length >= 2);
  assert.ok((await call('GET', `${G}/search?q=egrants&kinds=program`)).data.hits.every(h => h.kind === 'program'));
  assert.equal((await call('GET', `${G}/search?q=egrants&state=LA`)).data.hits.length, 0);
  assert.equal((await call('GET', `${G}/search?q=e`)).data.hits.length, 0, 'one letter is not a search');
  assert.equal((await call('GET', `${G}/search?q=100%25`)).data.hits.length, 0, 'a percent sign is a character, not a wildcard');
});

await check('needs-attention lists what is unverified, flagged, open, soon and missing', async () => {
  const q = await create({ jurisdiction: 'TX', kind: 'note', data: { category: 'open_question', title: 'Is the FY26 Stage 1 date 2/12 or 3/12?' } });
  let a = (await call('GET', `${G}/needs-attention?days=200`)).data;
  assert.ok(a.unverified.some(x => x.record_id === q.id));
  assert.ok(a.open_questions.some(x => x.record_id === q.id));
  assert.equal(a.deadlines_soon.length, 2, 'TX Stage 1 and LA, not the passed ones');
  assert.ok(a.missing.some(x => x.jurisdiction === 'NY' && /no jurisdiction record/.test(x.what)));
  assert.ok(a.missing.some(x => x.jurisdiction === 'LA' && /no contact/.test(x.what)));
  assert.ok(a.missing.some(x => x.jurisdiction === 'TX' && /NSGP-UA: no cycle/.test(x.what)));
  assert.equal(a.counts.open_questions, a.open_questions.length);
  await call('PATCH', `${G}/records/${q.id}`, { body: { version: q.version, data: { resolved: true, resolved_at: '2026-09-17' } } });
  a = (await call('GET', `${G}/needs-attention?state=TX`)).data;
  assert.ok(!a.open_questions.some(x => x.record_id === q.id));
  assert.ok(a.missing.every(x => x.jurisdiction === 'TX'));
});

await check('the overview is always 57 rows, whatever has been entered', async () => {
  const o = (await call('GET', `${G}/overview`)).data.jurisdictions;
  assert.equal(o.length, 57);
  const row = o.find(x => x.code === 'TX');
  assert.equal(row.saa_short, 'OOG PSO'); assert.equal(row.cycle_state, 'soon'); assert.equal(row.has_state_program, false);
  assert.deepEqual(row.programs.map(p => p.key), ['NSGP-S', 'NSGP-UA']);
  const gu = o.find(x => x.code === 'GU');
  assert.equal(gu.jurisdiction_kind, 'territory'); assert.equal(gu.cycle_state, 'unknown'); assert.equal(gu.freshness.records, 0);
  assert.equal(o.find(x => x.code === 'US').jurisdiction_kind, 'federal');
});

await check('bulk verify reports each record, and a stale version in the batch does not stop the rest', async () => {
  const doc = (await call('GET', `${G}/jurisdictions/TX`)).data;
  const notes = doc.notes.filter(n => n.status === 'unverified');
  assert.ok(notes.length >= 2);
  const ids = notes.map((n, i) => ({ id: n.id, version: i === 0 ? n.version + 5 : n.version }));
  const r = await call('POST', `${G}/jurisdictions/TX/verify-bulk`, { headers: BRAD, body: { ids } });
  assert.equal(r.data.failed, 1); assert.equal(r.data.verified, notes.length - 1);
  assert.equal(r.data.results[1].record.verified_by, 'Brad');
  const wrongState = await call('POST', `${G}/jurisdictions/LA/verify-bulk`, { body: { ids: [{ id: notes[0].id, version: notes[0].version }] } });
  assert.equal(wrongState.data.failed, 1);
});

// ── 9. Who ────────────────────────────────────────────────────────────────────
await check('a key that is not the proxy cannot name someone else; the state history names everyone', async () => {
  const r = await create({ jurisdiction: 'LA', kind: 'source', data: { url: 'https://gohsep.la.gov/grants' } }, { Authorization: 'Bearer team-key-one', 'X-Actor': 'Mallory' });
  assert.equal(r.created_by, fingerprint('team-key-one'));
  assert.equal((await revisionsOf(r.id))[0].actor_kind, 'key');
  const hist = (await call('GET', `${G}/jurisdictions/TX/revisions?limit=200`)).data.revisions;
  assert.ok(hist.length > 15);
  assert.deepEqual([...new Set(hist.map(h => h.actor))].sort(), ['Brad', 'Stuart']);
  assert.ok(hist.every((h, i) => i === 0 || hist[i - 1].id > h.id), 'newest first');
  const page = (await call('GET', `${G}/jurisdictions/TX/revisions?limit=3&before=${hist[2].id}`)).data.revisions;
  assert.equal(page[0].id, hist[3].id);
  const all = (await call('GET', `${G}/revisions?limit=5`)).data.revisions;
  assert.equal(all.length, 5);
  assert.equal(store._revisions.length, new Set(store._revisions.map(v => `${v.record_id}:${v.version_to}`)).size, 'one revision per version, no more');
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll grant knowledge checks passed');
process.exit(failures ? 1 : 0);
