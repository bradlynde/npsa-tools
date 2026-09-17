#!/usr/bin/env node
/*
 * Grant-clients route check.
 *
 * Mounts server/intake.js on a throwaway express app with the in-memory store, so
 * this runs with no database. It checks:
 *
 *   1. The gates. Team routes refuse without a key (401, fail closed), accept a
 *      key from MCP_API_KEYS or the boot-time internal key. Client routes refuse a
 *      wrong or missing token and never confirm which slugs exist.
 *   2. Registration. Slug derived from the name, validated, unique; token minted;
 *      contacts recorded with the first one primary; intake_url built from the
 *      configured public base.
 *   3. Answers. A seed with an unknown key is refused naming the key and writes
 *      nothing; a good seed lands with updated_by = seed:<actor>; a client save
 *      lands as client:<who> and bumps last_client_activity_at where a seed does
 *      not; meta keys are server-only from the client side.
 *   4. Status. Core and checklist counts, per-section counts, the submit stamp,
 *      and the list summary agree with what was written.
 *   5. Updates. Patch, contact add/remove, submitted stamping, token rotation
 *      killing the old link, and the page route's token handling (including the
 *      Gmail-mangled query rescue).
 *   6. The page. The real template renders with the client's values injected as
 *      JSON, a value that tries to close the script tag cannot, the upload route
 *      answers 401 without the token, and a route without the template answers
 *      503 rather than serving something half-filled.
 *   7. Uploads. Multipart in, type decided by the first bytes, size capped, the
 *      up_* answer written and the quiet clock reset, list and download for the
 *      team, CORS only for the page's own origin, and the Drive mirror: a real
 *      RS256 JWT exchanged at a fake token endpoint, the file posted to a fake
 *      Drive, the link recorded — and a Drive failure that leaves the upload
 *      intact.
 *
 *   node scripts/intake-smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { capsFor, registerIntake, createMemoryStore, renderClientPage, QUESTIONS, normaliseAnswers, slugify, healToken, sniffUploadType, UPLOAD_MAX_BYTES } from '../server/intake.js';
import { accessToken, uploadToDrive } from '../server/drive.js';

const INTERNAL = 'boot-secret-for-test';
const BASE = 'https://npsa-tools.vercel.app';
process.env.MCP_API_KEYS = 'team-key-one, team-key-two';

const app = express();
app.use(['/api/clients', '/api/intake'], express.json({ limit: '2mb' }));
app.use(express.json());
const store = createMemoryStore();
let rendered = null;
registerIntake(app, {
  store, internalKey: INTERNAL, publicBase: BASE,
  renderPage: ({ client, stateConfig, existing, contacts }) => { rendered = { client, stateConfig, existing, contacts }; return `<html>page for ${client.slug}</html>`; },
});
const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;

const TEAM = { Authorization: 'Bearer team-key-two' };
const INTERNAL_H = { 'X-Internal-Key': INTERNAL, 'X-Actor': 'abcd1234' };
async function call(method, path, { headers = {}, body } = {}) {
  const r = await fetch(origin + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

// ── 1. Gates ──────────────────────────────────────────────────────────────────
await check('team route without a key is 401', async () => {
  const r = await call('GET', '/api/clients');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') || '', /Bearer/);
});
await check('team route with a wrong key is 401', async () => {
  assert.equal((await call('GET', '/api/clients', { headers: { Authorization: 'Bearer nope' } })).status, 401);
});
await check('team route with a wrong internal key is 401', async () => {
  assert.equal((await call('GET', '/api/clients', { headers: { 'X-Internal-Key': 'boot-secret-for-tesT' } })).status, 401);
});
await check('a configured key and the internal key both get in', async () => {
  assert.equal((await call('GET', '/api/clients', { headers: TEAM })).status, 200);
  assert.equal((await call('GET', '/api/clients', { headers: INTERNAL_H })).status, 200);
});
await check('with MCP_API_KEYS unset only the internal key gets in', async () => {
  const saved = process.env.MCP_API_KEYS; delete process.env.MCP_API_KEYS;
  try {
    assert.equal((await call('GET', '/api/clients', { headers: TEAM })).status, 401);
    assert.equal((await call('GET', '/api/clients', { headers: INTERNAL_H })).status, 200);
  } finally { process.env.MCP_API_KEYS = saved; }
});

// ── 2. Registration ───────────────────────────────────────────────────────────
await check('catalog is served with 685 questions and the section list', async () => {
  const r = await call('GET', '/api/intake/questions', { headers: TEAM });
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 685);
  assert.equal(QUESTIONS.length, 685);
  assert.ok(r.data.sections.includes('Checklist'));
  const chk = await call('GET', '/api/intake/questions?prefix=chk_who_', { headers: TEAM });
  assert.ok(chk.data.count > 0 && chk.data.questions.every(q => q.key.startsWith('chk_who_')));
  const sec = await call('GET', '/api/intake/questions?section=uploads', { headers: TEAM });
  assert.equal(sec.data.count, 4);
});

let created;
await check('client_create derives the slug, mints a token, builds the link, records contacts', async () => {
  const r = await call('POST', '/api/clients', { headers: INTERNAL_H, body: {
    name: 'Trinity Wellsprings Church', state: 'fl', kickoff_date: '2026-09-08', upload_folder_id: 'PHASE2',
    contacts: [{ name: 'Pat Lee', email: 'Pat@Trinity.org', role: 'Executive Pastor' }, { email: 'admin@trinity.org' }],
  } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created = r.data;
  assert.equal(created.slug, 'trinity-wellsprings-church');
  assert.equal(created.state, 'FL');
  assert.equal(created.phase, 2);
  assert.equal(created.status, 'active');
  assert.equal(created.saa, 'Florida Division of Emergency Management (FDEM)');
  assert.equal(created.token, undefined, 'token is not echoed as a field');
  assert.match(created.intake_url, new RegExp(`^${BASE}/client/trinity-wellsprings-church\\?t=[0-9a-f]{20}$`));
  assert.equal(created.contacts.length, 4, 'two from the request plus the standing NPSA team');
  assert.deepEqual(created.contacts.map(c => c.side), ['npsa', 'npsa', 'client', 'client'], 'NPSA rows first');
  assert.equal(created.contacts[0].email, 'stuart@nonprofitsecurityadvisors.com');
  assert.equal(created.contacts[0].phone, '(815) 550-5222');
  const pat = created.contacts.find(c => c.email === 'pat@trinity.org');
  assert.equal(pat.is_primary, true);
  assert.equal(pat.added_by, 'npsa:abcd1234');
  assert.equal(pat.side, 'client');
});
const token = () => new URL(created.intake_url).searchParams.get('t');

await check('duplicate slug is 409, bad slug/state/date are 400', async () => {
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Trinity Wellsprings Church', state: 'FL' } })).status, 409);
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { name: 'X', slug: 'Bad Slug', state: 'FL' } })).status, 400);
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { name: 'X', slug: 'questions', state: 'FL' } })).status, 400);
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { name: 'X', state: 'Florida' } })).status, 400);
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { name: 'X', state: 'FL', kickoff_date: '9/8/2026' } })).status, 400);
  assert.equal((await call('POST', '/api/clients', { headers: TEAM, body: { state: 'FL' } })).status, 400);
});

await check('an import can supply its old slug and token', async () => {
  const r = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'New Life Church', slug: 'new-life-ky', state: 'KY', token: 'abc123def456', status: 'active' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.intake_url, `${BASE}/client/new-life-ky?t=abc123def456`);
  assert.equal(slugify('St. Peter\'s Episcopal — Del Mar'), 'st-peter-s-episcopal-del-mar');
});

// ── 3. Answers ────────────────────────────────────────────────────────────────
await check('a seed with an unknown key is refused by name and writes nothing', async () => {
  const r = await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { q_1_1_1: 'Pat Lee', chk_note_10: 'x', chk_who_investment_justification: 'me' } } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data.unknown_keys, ['chk_note_10', 'chk_who_investment_justification']);
  assert.match(r.data.error, /chk_note_10/);
  const a = await call('GET', `/api/clients/${created.slug}/answers`, { headers: TEAM });
  assert.equal(a.data.count, 0);
});
await check('normaliseAnswers rejects objects and empties, allows meta only when told', async () => {
  assert.throws(() => normaliseAnswers({}), /empty/);
  assert.throws(() => normaliseAnswers({ q_1_1_1: { a: 1 } }), /must be text/);
  assert.throws(() => normaliseAnswers({ _status: 'x' }), /set by the server/);
  assert.equal(normaliseAnswers({ _status: 'x' }, { allowMeta: true })[0].value, 'x');
  assert.equal(normaliseAnswers({ q_1_3_7: 12 })[0].value, '12');
  assert.equal(normaliseAnswers({ q_1_3_7: null })[0].value, '');
});
await check('a good seed lands as seed:<actor> and does not bump client activity', async () => {
  const r = await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: {
    q_1_1_1: 'Pat Lee', q_1_3_1: 'Trinity Wellsprings Church, Inc.', loc1_name: 'Main campus',
    chk_status_kickoff_call: 'Completed', chk_status_state_reg: 'In progress', chk_due_state_reg: '9/15/2026', chk_who_state_reg: 'Pat (DEMES account)',
  } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.written, 7);
  const a = await call('GET', `/api/clients/${created.slug}/answers`, { headers: TEAM });
  assert.equal(a.data.count, 7);
  const first = a.data.answers[0];
  assert.equal(first.key, 'q_1_1_1', 'catalog order');
  assert.equal(first.label, '1.1.1 Name');
  assert.equal(first.updated_by, 'seed:abcd1234');
  const c = await call('GET', `/api/clients/${created.slug}`, { headers: TEAM });
  assert.equal(c.data.last_client_activity_at, null);
  assert.deepEqual(c.data.checklist, { completed: 1, total: 24, not_applicable: 0 });
  assert.equal(c.data.core.answered, 3);
});
await check('a section filter and include_empty work', async () => {
  const s = await call('GET', `/api/clients/${created.slug}/answers?section=locations`, { headers: TEAM });
  assert.equal(s.data.count, 1);
  const all = await call('GET', `/api/clients/${created.slug}/answers?section=uploads&include_empty=1`, { headers: TEAM });
  assert.equal(all.data.count, 4);
  assert.ok(all.data.answers.every(r => r.value === ''));
});
await check('client save needs the right token and never confirms a slug', async () => {
  const body = { answers: { q_1_1_2: 'Executive Pastor' } };
  const none = await call('PUT', `/api/intake/${created.slug}/answers`, { body });
  assert.equal(none.status, 401);
  const wrong = await call('PUT', `/api/intake/${created.slug}/answers`, { headers: { 'X-Intake-Token': 'ffffffffffffffffffff' }, body });
  assert.equal(wrong.status, 401);
  const ghost = await call('PUT', `/api/intake/no-such-client/answers`, { headers: { 'X-Intake-Token': token() }, body });
  assert.equal(ghost.status, 401);
  assert.equal(ghost.data.error, wrong.data.error, 'same answer for unknown slug and wrong token');
});
await check('client save lands as client:<who>, bumps activity, and cannot touch meta keys', async () => {
  const h = { 'X-Intake-Token': token() };
  const meta = await call('PUT', `/api/intake/${created.slug}/answers`, { headers: h, body: { answers: { _status: 'hacked' } } });
  assert.equal(meta.status, 400);
  const who = await call('PUT', `/api/intake/${created.slug}/answers`, { headers: h, body: { answers: { _filled_by: 'Pat Lee, Exec Pastor' } } });
  assert.equal(who.status, 200);
  const r = await call('PUT', `/api/intake/${created.slug}/answers`, { headers: h, body: { answers: { q_1_1_2: 'Executive Pastor', q_3_1_1: 450 } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.saved, 2);
  const a = await call('GET', `/api/clients/${created.slug}/answers?section=1. applicant information`, { headers: TEAM });
  const row = a.data.answers.find(x => x.key === 'q_1_1_2');
  assert.equal(row.value, 'Executive Pastor');
  assert.equal(row.updated_by, 'client:Pat Lee, Exec Pastor');
  const c = await call('GET', `/api/clients/${created.slug}`, { headers: TEAM });
  assert.ok(c.data.last_client_activity_at, 'activity bumped');
  assert.equal(c.data.filled_by, 'Pat Lee, Exec Pastor');
});

// ── 4. Status ─────────────────────────────────────────────────────────────────
await check('status reports sections, checklist items and the headline counts', async () => {
  const r = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.core.answered, 5);
  assert.equal(d.checklist.completed, 1);
  assert.equal(d.checklist.items.length, 24);
  const reg = d.checklist.items.find(i => i.stem === 'state_reg');
  assert.deepEqual([reg.label, reg.status, reg.due, reg.owner], ['State registration', 'In progress', '9/15/2026', 'Pat (DEMES account)']);
  const s1 = d.sections.find(s => s.section === '1. Applicant Information');
  assert.deepEqual([s1.answered, s1.total], [3, 18]);
  assert.equal(d.status_line, '');
  assert.deepEqual(d.uploads, []);
  // Nothing prioritized yet: three facilities, all empty.
  assert.equal(d.wish_list.length, 3);
  assert.deepEqual(d.wish_list[0], { facility: 1, name: 'Main campus', prioritized: 0, details: { answered: 0, total: 0 }, items: [], budget: { items: 0, ma: 0, ma_on: true, ma_default: true, total: 0, programs: ['NSGP'], uncosted: 0, cap: 200000, cap_assumed: true, room: 200000 } });
});
await check('wish list counts only prioritized items, and their five detail fields', async () => {
  await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: {
    wl_f1_cctv_camera_system_int: '1', wl_f1_cctv_camera_system_desc: '12 cameras', wl_f1_cctv_camera_system_where: 'entrances', wl_f1_cctv_camera_system_cost: '18000',
    wl_f1_vehicle_bollards_int: '2', wl_f1_vehicle_bollards_desc: 'front walk',
    wl_f1_lockdown_system_cur: 'none yet', // a detail without a priority does not count
  } } });
  const r = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  const f1 = r.data.wish_list[0];
  assert.equal(f1.prioritized, 2);
  assert.deepEqual(f1.details, { answered: 4, total: 10 });
  assert.deepEqual(f1.items.map(i => [i.label, i.priority, i.answered, i.total]), [['CCTV / Camera System', 1, 3, 5], ['Vehicle Bollards', 2, 1, 5]]);
  assert.equal(r.data.wish_list[1].prioritized, 0);
  // Budget: costs parse loosely, M&A defaults to 5% of the items, and can be turned off or set.
  const b1 = r.data.wish_list[0].budget;
  assert.deepEqual([b1.items, b1.ma, b1.ma_on, b1.ma_default, b1.total, b1.cap, b1.room, b1.uncosted], [18000, 900, true, true, 18900, 200000, 181100, 1]);
  assert.deepEqual(r.data.budget, { requested: 18900, cap: 200000, room: 181100, sites: 1, federal: 200000, state: 0, state_program: null, state_cap_unknown: false, assumed_federal: true });
  await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { wl_f1_vehicle_bollards_cost: '$52,000', wl_f1_ma_amount: '3,500' } } });
  const r2 = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.deepEqual([r2.data.wish_list[0].budget.items, r2.data.wish_list[0].budget.ma, r2.data.wish_list[0].budget.total], [70000, 3500, 73500]);
  await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { wl_f1_ma_on: 'off' } } });
  const r3 = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.deepEqual([r3.data.wish_list[0].budget.ma, r3.data.wish_list[0].budget.ma_on, r3.data.wish_list[0].budget.total], [0, false, 70000]);
});
await check('caps follow the programs each site applies for', async () => {
  // California: federal $200k a site; CSNSGP $250k a site, $500k an applicant.
  assert.deepEqual(capsFor('CA', [{ facility: 1, programs: 'Federal NSGP-S' }]).cap, 200000);
  const two = capsFor('CA', [{ facility: 1, programs: 'Federal + State' }, { facility: 2, programs: 'Federal + State' }]);
  assert.deepEqual([two.federal, two.state, two.cap, two.sites.map(x => x.cap)], [400000, 500000, 900000, [450000, 450000]]);
  const three = capsFor('CA', [{ facility: 1, programs: 'Federal + State' }, { facility: 2, programs: 'Federal + State' }, { facility: 3, programs: 'Federal + State' }]);
  assert.deepEqual([three.federal, three.state, three.cap], [600000, 500000, 1100000]);
  const stateOnly = capsFor('CA', [{ facility: 1, programs: 'State Program' }]);
  assert.deepEqual([stateOnly.federal, stateOnly.state, stateOnly.sites[0].programs], [0, 250000, ['CSNSGP']]);
  // New York's SCAHC has only an applicant cap; Georgia's FPC has none published.
  const ny = capsFor('NY', [{ facility: 1, programs: 'Federal + State' }, { facility: 2, programs: 'Federal + State' }]);
  assert.deepEqual([ny.federal, ny.state, ny.sites[0].cap], [400000, 250000, 200000]);
  const ga = capsFor('GA', [{ facility: 1, programs: 'Federal + State' }]);
  assert.deepEqual([ga.cap, ga.state_cap_unknown], [200000, true]);
  // Blank means federal, and says so.
  const blank = capsFor('TX', [{ facility: 1, programs: '' }]);
  assert.deepEqual([blank.cap, blank.assumed_federal], [200000, true]);
});
await check('site research: loc<n>_infra is accepted and stays out of the core count', async () => {
  const before = (await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM })).data.core;
  const w = await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { loc1_infra: 'TRANSIT\n- Station 0.3 mi N', resp_q_4_6: 'legacy blob' } } });
  assert.equal(w.status, 200);
  const after = (await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM })).data;
  assert.deepEqual(after.core, before);
  assert.equal(after.sections.find(x => x.section === 'Locations').total, 36);
});
await check('checklist: Not applicable leaves the total and is reported', async () => {
  await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { chk_status_confirm_obtain_ein: 'Not applicable' } } });
  const r = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.deepEqual([r.data.checklist.completed, r.data.checklist.total, r.data.checklist.not_applicable], [1, 23, 1]);
  assert.equal(r.data.checklist.items.find(i => i.stem === 'confirm_obtain_ein').status, 'Not applicable');
});
await check('programs: 20 slots accepted, status counts the named rows, 3.2.1 is retired but still readable', async () => {
  const w = await call('PUT', `/api/clients/${created.slug}/answers`, { headers: INTERNAL_H, body: { answers: { prog1_name: 'Sunday Service', prog12_name: 'GriefShare', prog12_runby: 'Outside', prog20_desc: 'no name yet', q_3_2_1: 'legacy free text' } } });
  assert.equal(w.status, 200);
  const r = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.deepEqual(r.data.programs, { listed: 2, slots: 20 });
  assert.ok(!r.data.sections.find(x => x.section === '3. Community Role').total.toString().includes('x'));
  const a = await call('GET', `/api/clients/${created.slug}/answers?section=3.%20Community%20Role`, { headers: TEAM });
  const legacy = a.data.answers.find(x => x.key === 'q_3_2_1');
  assert.equal(legacy.value, 'legacy free text');
  assert.equal(legacy.kind, 'meta');
});
await check('complete stamps _status, marks submitted, and shows on the list', async () => {
  const r = await call('POST', `/api/intake/${created.slug}/complete`, { headers: { 'X-Intake-Token': token() } });
  assert.equal(r.status, 200);
  assert.match(r.data.status, /^Submitted .* CT by Pat Lee, Exec Pastor$/);
  const c = await call('GET', `/api/clients/${created.slug}`, { headers: TEAM });
  assert.equal(c.data.status, 'submitted');
  assert.ok(c.data.submitted_at);
  assert.equal(c.data.status_line, r.data.status);
  const active = await call('GET', '/api/clients', { headers: TEAM });
  assert.deepEqual(active.data.map(x => x.slug), ['new-life-ky']);
  const sub = await call('GET', '/api/clients?status=submitted', { headers: TEAM });
  assert.deepEqual(sub.data.map(x => x.slug), [created.slug]);
  assert.deepEqual(sub.data[0].core, { answered: 5, total: c.data.core.total });
  assert.equal(sub.data[0].filled_by, 'Pat Lee, Exec Pastor');
  const all = await call('GET', '/api/clients?status=all&search=trin', { headers: TEAM });
  assert.equal(all.data.length, 1);
});

// ── 5. Updates ────────────────────────────────────────────────────────────────
await check('patch changes only what is given and manages contacts', async () => {
  const empty = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: {} });
  assert.equal(empty.status, 400);
  const bad = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { status: 'done' } });
  assert.equal(bad.status, 400);
  const r = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: {
    asana_project_gid: '1217000000000000', phase: 3, add_contacts: [{ name: 'Sam', email: 'sam@trinity.org' }], remove_contact_emails: ['admin@trinity.org'],
  } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.asana_project_gid, '1217000000000000');
  assert.equal(r.data.phase, 3);
  assert.equal(r.data.name, 'Trinity Wellsprings Church', 'untouched');
  assert.deepEqual(r.data.contacts.filter(c => c.side === 'client').map(c => c.email), ['pat@trinity.org', 'sam@trinity.org']);
  const rep2 = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { add_npsa_contacts: [{ name: 'Jeff Markley', email: 'jeff@nonprofitsecurityadvisors.com', role: 'Sales rep' }] } });
  assert.equal(rep2.status, 200);
  const jeff = rep2.data.contacts.find(c => c.email === 'jeff@nonprofitsecurityadvisors.com');
  assert.equal(jeff.side, 'npsa');
  assert.equal(rep2.data.contacts.filter(c => c.side === 'npsa').length, 3);
  const missing = await call('PATCH', '/api/clients/nobody', { headers: TEAM, body: { phase: 2 } });
  assert.equal(missing.status, 404);
});
await check('the client can list, add and remove their own contacts but not the NPSA team', async () => {
  const h = { 'X-Intake-Token': token() };
  assert.equal((await call('GET', `/api/intake/${created.slug}/contacts`)).status, 401);
  const list = await call('GET', `/api/intake/${created.slug}/contacts`, { headers: h });
  assert.equal(list.status, 200);
  assert.equal(list.data.npsa.length, 3);
  assert.deepEqual(list.data.client.map(c => c.email), ['pat@trinity.org', 'sam@trinity.org']);
  assert.equal(list.data.npsa[0].added_by, 'npsa:abcd1234');
  assert.equal(Object.keys(list.data.npsa[0]).includes('is_primary'), false, 'only public fields');
  const noName = await call('POST', `/api/intake/${created.slug}/contacts`, { headers: h, body: { email: 'x@trinity.org' } });
  assert.equal(noName.status, 400);
  const badEmail = await call('POST', `/api/intake/${created.slug}/contacts`, { headers: h, body: { name: 'X', email: 'not-an-email' } });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.data.error, /valid email/);
  const npsaEmail = await call('POST', `/api/intake/${created.slug}/contacts`, { headers: h, body: { name: 'X', email: 'brad@lyndeconsulting.com' } });
  assert.equal(npsaEmail.status, 400);
  const added = await call('POST', `/api/intake/${created.slug}/contacts`, { headers: h, body: { name: 'Lee Park', role: 'Facilities Director', email: 'Lee@Trinity.org', phone: '(555) 555-1212' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.deepEqual(added.data.client.map(c => c.email), ['pat@trinity.org', 'sam@trinity.org', 'lee@trinity.org']);
  assert.equal(added.data.client[2].phone, '(555) 555-1212');
  assert.equal(added.data.client[2].added_by, 'client:Pat Lee, Exec Pastor');
  const team = await call('GET', `/api/clients/${created.slug}`, { headers: TEAM });
  assert.equal(team.data.contacts.find(c => c.email === 'lee@trinity.org').side, 'client');
  const rmNpsa = await call('DELETE', `/api/intake/${created.slug}/contacts?email=stuart%40nonprofitsecurityadvisors.com`, { headers: h });
  assert.equal(rmNpsa.status, 400);
  const rm = await call('DELETE', `/api/intake/${created.slug}/contacts?email=lee%40trinity.org`, { headers: h });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.data.client.map(c => c.email), ['pat@trinity.org', 'sam@trinity.org']);
  assert.equal((await call('DELETE', `/api/intake/${created.slug}/contacts?email=nobody%40trinity.org`, { headers: h })).status, 404);
});

await check('page route: unknown slug and wrong token get the error page, right token renders', async () => {
  const unknown = await call('GET', '/client/nobody?t=abc');
  assert.equal(unknown.status, 404);
  assert.match(unknown.data, /isn’t recognized/);
  const wrong = await call('GET', `/client/${created.slug}?t=nope`);
  assert.equal(wrong.status, 404);
  assert.match(wrong.data, /invalid or has expired/);
  assert.equal(rendered, null);
  const ok = await call('GET', `/client/${created.slug}?t=${token()}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(rendered.client.slug, created.slug);
  assert.equal(rendered.stateConfig.saa, 'FDEM');
  assert.equal(rendered.existing.q_1_1_2, 'Executive Pastor');
  assert.equal(rendered.existing.up_mission, undefined, 'empty answers are not injected');
  assert.equal(rendered.contacts.npsa.length, 3, 'contacts injected for the tab');
  assert.equal(rendered.contacts.client[0].email, 'pat@trinity.org');
});
await check('page route rescues a Gmail-mangled query string', async () => {
  rendered = null;
  const r = await call('GET', `/client/${created.slug}?client%3D${created.slug}%26t%3D${token()}&source=gmail&ust=1&sa=E`);
  assert.equal(r.status, 200);
  assert.equal(rendered.client.slug, created.slug);
  assert.equal(healToken({}, 'client%3Dslug%26t%3Dabc123'), 'abc123');
  assert.equal(healToken({ t: 'direct' }, 'anything'), 'direct');
});
await check('token rotation kills the old link and issues a new one', async () => {
  const old = token();
  const r = await call('POST', `/api/clients/${created.slug}/token`, { headers: INTERNAL_H });
  assert.equal(r.status, 200);
  const fresh = new URL(r.data.intake_url).searchParams.get('t');
  assert.notEqual(fresh, old);
  assert.equal((await call('GET', `/client/${created.slug}?t=${old}`)).status, 404);
  assert.equal((await call('GET', `/client/${created.slug}?t=${fresh}`)).status, 200);
  assert.equal((await call('PUT', `/api/intake/${created.slug}/answers`, { headers: { 'X-Intake-Token': old }, body: { answers: { q_1_1_1: 'x' } } })).status, 401);
  created.intake_url = r.data.intake_url; // later sections use the live token
});
// ── 6. The page ───────────────────────────────────────────────────────────────
await check('renderClientPage fills every placeholder and escapes a script-closing value', async () => {
  const html = renderClientPage({
    client: { slug: 'evil-co', token: 'abc123def456', name: 'Evil </script><img src=x onerror=alert(1)> Co', state: 'KY' },
    stateConfig: { saa: 'KOHS', registration: ['x — hard gate'], programs: [], perSiteCap: '', stateCap: '' },
    existing: { q_1_1_1: 'line\u2028break', q_2_1: '<b>bold</b>' },
  });
  const withContacts = renderClientPage({ client: { slug: 'a-b', token: 't', name: 'A', state: 'IL' }, stateConfig: {}, existing: {}, contacts: { npsa: [{ name: 'S', email: 's@x.org' }], client: [{ name: '</script>', email: 'c@x.org' }] } });
  assert.ok(withContacts.includes('CONTACTS={"npsa":[{"name":"S","email":"s@x.org"}],"client":[{"name":"\\u003c/script\\u003e","email":"c@x.org"}]}'), 'contacts escaped');
  assert.ok(html && html.length > 200000, 'template rendered');
  assert.ok(!/\{\{\w+\}\}/.test(html), 'no placeholder left');
  assert.ok(html.includes('var CLIENT="evil-co",TOKEN="abc123def456"'));
  assert.ok(html.includes('CLIENT_NAME="Evil \\u003c/script\\u003e'), 'script close escaped');
  assert.ok(!html.includes('</script><img'), 'raw closing tag never appears');
  assert.ok(html.includes('"q_1_1_1":"line\\u2028break"'), 'line separator escaped');
  assert.ok(html.includes('API_BASE=""'));
  assert.ok(html.includes('CONTACTS={"npsa":[],"client":[],"reference":[]}'), 'contacts default to empty');
  assert.ok(html.includes('data-tab="ct"') && html.includes('id="ctAddBtn"'), 'contacts tab present');
  assert.ok(html.includes('"saa":"KOHS"'));
  assert.ok(!html.includes('google.script'), 'no Apps Script left');
  assert.ok(html.includes('/answers') && html.includes('/complete') && html.includes('/upload'));
  const remote = renderClientPage({ client: { slug: 'a-b', token: 't', name: 'A', state: 'IL' }, stateConfig: {}, existing: {}, apiBase: 'https://loe.example' });
  assert.ok(remote.includes('API_BASE="https://loe.example"'));
});
await check('the page route serves the real template by default', async () => {
  const app3 = express(); app3.use(express.json());
  registerIntake(app3, { store: createMemoryStore(), internalKey: INTERNAL, publicBase: BASE });
  const s3 = await new Promise(resolve => { const s = app3.listen(0, () => resolve(s)); });
  const o3 = `http://127.0.0.1:${s3.address().port}`;
  const c = await (await fetch(`${o3}/api/clients`, { method: 'POST', headers: { ...TEAM, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Page Test Church', state: 'FL' }) })).json();
  const t = new URL(c.intake_url).searchParams.get('t');
  const page = await fetch(`${o3}/client/page-test-church?t=${t}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('var CLIENT="page-test-church"'));
  assert.ok(html.includes('"saa":"FDEM"'));
  assert.ok(html.includes('UPLOAD_BASE=""'));
  assert.equal((await fetch(`${o3}/api/intake/page-test-church/upload`, { method: 'POST' })).status, 401);
  s3.close();
});
// ── 7. Uploads ────────────────────────────────────────────────────────────────
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
function multipart(key, name, bytes, type = 'application/octet-stream') {
  const fd = new FormData();
  if (key !== null) fd.append('key', key);
  if (name !== null) fd.append('file', new Blob([bytes], { type }), name);
  return fd;
}
const upload = (slug, tok, fd, extra = {}) => fetch(`${origin}/api/intake/${slug}/upload`, { method: 'POST', headers: { ...(tok ? { 'X-Intake-Token': tok } : {}), ...extra }, body: fd });

await check('sniffUploadType decides by the first bytes', async () => {
  assert.equal(sniffUploadType(PDF), 'application/pdf');
  assert.equal(sniffUploadType(PNG), 'image/png');
  assert.equal(sniffUploadType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffUploadType(Buffer.from('PK\u0003\u0004 a docx')), null);
  assert.equal(sniffUploadType(Buffer.alloc(0)), null);
});

await check('an upload needs the token, an upload key, and a real PDF/JPG/PNG', async () => {
  const t = token();
  assert.equal((await upload(created.slug, null, multipart('up_mission', 'm.pdf', PDF))).status, 401);
  assert.equal((await upload(created.slug, 'ffffffffffffffffffff', multipart('up_mission', 'm.pdf', PDF))).status, 401);
  const badKey = await upload(created.slug, t, multipart('q_1_1_1', 'm.pdf', PDF));
  assert.equal(badKey.status, 400);
  assert.match((await badKey.json()).error, /not one of this client's documents/);
  const docx = await upload(created.slug, t, multipart('up_mission', 'm.docx', Buffer.from('PK\u0003\u0004zip'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.equal(docx.status, 400);
  assert.match((await docx.json()).error, /PDF, JPG, or PNG/);
  const lying = await upload(created.slug, t, multipart('up_mission', 'm.pdf', Buffer.from('not a pdf'), 'application/pdf'));
  assert.equal(lying.status, 400, 'declared type does not count');
  const empty = await upload(created.slug, t, multipart('up_mission', 'm.pdf', Buffer.alloc(0), 'application/pdf'));
  assert.equal(empty.status, 400);
  const noFile = await upload(created.slug, t, multipart('up_mission', null, PDF));
  assert.equal(noFile.status, 400);
  const notMultipart = await fetch(`${origin}/api/intake/${created.slug}/upload`, { method: 'POST', headers: { 'X-Intake-Token': t, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(notMultipart.status, 400);
  assert.match((await notMultipart.json()).error, /multipart/);
});

await check('a file over 25 MB is refused before it is parsed', async () => {
  const big = Buffer.alloc(UPLOAD_MAX_BYTES + 2 * 1024 * 1024, 0x20); PDF.copy(big);
  const r = await upload(created.slug, token(), multipart('up_mission', 'huge.pdf', big, 'application/pdf'));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /25 MB/);
});

let uploadId;
await check('a good upload is stored, listed, downloadable, and written into the up_* answer', async () => {
  const before = (await call('GET', `/api/clients/${created.slug}`, { headers: TEAM })).data.last_client_activity_at;
  const r = await upload(created.slug, token(), multipart('up_501c3', '../IRS letter (2018).pdf', PDF, 'application/pdf'));
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const d = JSON.parse(body);
  assert.equal(d.ok, true);
  assert.equal(d.filename, 'IRS letter (2018).pdf', 'path stripped');
  assert.equal(d.mime, 'application/pdf');
  assert.equal(d.size_bytes, PDF.length);
  assert.equal(d.drive_url, null, 'no Drive configured here');
  uploadId = d.id;
  const list = await call('GET', `/api/clients/${created.slug}/uploads`, { headers: TEAM });
  assert.equal(list.data.count, 1);
  assert.equal(list.data.uploads[0].label, '501(c)(3) determination letter (file)');
  assert.equal(list.data.uploads[0].uploaded_by, 'client:Pat Lee, Exec Pastor');
  assert.equal(list.data.uploads[0].download_path, `/api/clients/${created.slug}/uploads/${uploadId}`);
  const dl = await fetch(`${origin}/api/clients/${created.slug}/uploads/${uploadId}`, { headers: TEAM });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="IRS letter \(2018\).pdf"/);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PDF), 'bytes round-trip');
  assert.equal((await fetch(`${origin}/api/clients/${created.slug}/uploads/${uploadId}`)).status, 401, 'download is a team route');
  assert.equal((await call('GET', `/api/clients/${created.slug}/uploads/999`, { headers: TEAM })).status, 404);
  const a = await call('GET', `/api/clients/${created.slug}/answers?section=uploads`, { headers: TEAM });
  assert.equal(a.data.count, 1);
  assert.match(a.data.answers[0].value, /^IRS letter \(2018\)\.pdf \(uploaded /);
  const st = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.equal(st.data.uploads.length, 1);
  assert.equal(st.data.sections.find(x => x.section === 'Uploads').answered, 1);
  const after = (await call('GET', `/api/clients/${created.slug}`, { headers: TEAM })).data.last_client_activity_at;
  assert.notEqual(after, before, 'quiet clock reset');
});

await check('CORS on the upload route answers only for the page origin', async () => {
  const ok = await fetch(`${origin}/api/intake/${created.slug}/upload`, { method: 'OPTIONS', headers: { Origin: BASE, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), BASE);
  assert.match(ok.headers.get('access-control-allow-headers'), /X-Intake-Token/);
  const other = await fetch(`${origin}/api/intake/${created.slug}/upload`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const posted = await upload(created.slug, token(), multipart('up_va', 'va.png', PNG, 'image/png'), { Origin: BASE });
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get('access-control-allow-origin'), BASE);
});

// ── 8. Documents and contacts ─────────────────────────────────────────────────
await check('documents: defaults by state, team edits, custom keys upload', async () => {
  const c = await call('GET', `/api/clients/${created.slug}`, { headers: TEAM });
  assert.deepEqual(c.data.documents.map(d => d.key), ['up_mission', 'up_501c3', 'up_va', 'up_bios']);
  assert.equal(c.data.documents_customised, false);
  const tx = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Lone Star Chapel', state: 'TX' } });
  assert.deepEqual(tx.data.documents.map(d => d.key).slice(4), ['up_gov_resolution', 'up_tx_payee']);
  await call('PATCH', '/api/clients/lone-star-chapel', { headers: TEAM, body: { status: 'cancelled' } });
  const r = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { remove_document_keys: ['up_bios'], add_documents: [{ key: 'up_board_list', label: 'Board roster', hint: 'PDF' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.documents.map(d => d.key), ['up_mission', 'up_501c3', 'up_va', 'up_board_list']);
  assert.equal(r.data.documents_customised, true);
  const bad = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { add_documents: [{ key: 'board', label: 'x' }] } });
  assert.equal(bad.status, 400);
  const reset = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { documents: null } });
  assert.equal(reset.data.documents_customised, false);
  await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { add_documents: [{ key: 'up_board_list', label: 'Board roster' }] } });
  const up = await upload(created.slug, token(), multipart('up_board_list', 'board.pdf', PDF, 'application/pdf'));
  assert.equal(up.status, 200, await up.text());
  const st = await call('GET', `/api/clients/${created.slug}/status`, { headers: TEAM });
  assert.ok(st.data.uploads.some(u => u.key === 'up_board_list' && u.label === 'Board roster'));
  const nope = await upload(created.slug, token(), multipart('up_nothing', 'x.pdf', PDF, 'application/pdf'));
  assert.equal(nope.status, 400);
});
await check('documents: California state-program clients get the Cal OES set; tasks and ready lines validate', async () => {
  const ca = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Del Mar Chapel', state: 'CA', program_track: '2026-27 CSNSGP' } });
  assert.equal(ca.status, 201, JSON.stringify(ca.data));
  assert.deepEqual(ca.data.documents.map(d => d.key), ['up_mission', 'up_501c3', 'up_va', 'up_proof_address', 'up_landlord_letter', 'up_site_map']);
  assert.ok(ca.data.documents.every(d => d.source === 'program'));
  assert.match(ca.data.documents.find(d => d.key === 'up_va').label, /Cal OES/);
  const fed = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Orange Federal Church', state: 'CA', program_track: 'FY2027 federal NSGP-S' } });
  assert.deepEqual(fed.data.documents.map(d => d.key), ['up_mission', 'up_501c3', 'up_va', 'up_bios']);
  const drop = await call('PATCH', '/api/clients/del-mar-chapel', { headers: TEAM, body: { remove_document_keys: ['up_landlord_letter'] } });
  assert.equal(drop.data.documents.find(d => d.key === 'up_va').task, 'vulnerability_assessment_received');
  const badTask = await call('PATCH', '/api/clients/del-mar-chapel', { headers: TEAM, body: { documents: [{ key: 'up_x', label: 'X', task: 'not_a_task' }] } });
  assert.equal(badTask.status, 400);
  const html = renderClientPage({ client: { slug: 'del-mar-chapel', token: 't', name: 'Del Mar Chapel', state: 'CA', program_track: '2026-27 CSNSGP' }, stateConfig: {}, existing: {} });
  assert.match(html, /up_proof_address/);
  assert.match(html, /srState\(it\)/);
  for (const slug of ['del-mar-chapel', 'orange-federal-church']) await call('PATCH', `/api/clients/${slug}`, { headers: TEAM, body: { status: 'cancelled' } });
});
await check('applications: stored list drives caps, documents and the page; derived when not set', async () => {
  const r = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Modesto Cove Church', state: 'CA', applications: [{ program: 'csnsgp', cycle: '2026-27' }, { program: 'NSGP-S', cycle: 'FY2027', status: 'planned' }] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.applications.map(a => [a.id, a.label, a.kind, a.status]), [['a1', 'CSNSGP 2026-27', 'state', 'active'], ['a2', 'NSGP-S FY2027', 'federal', 'planned']]);
  assert.ok(r.data.documents.some(d => d.key === 'up_site_map'), 'CSNSGP application brings the Cal OES documents');
  let st = await call('GET', '/api/clients/modesto-cove-church/status', { headers: TEAM });
  assert.equal(st.data.applications_set, true);
  assert.equal(st.data.budget.cap, 250000, 'planned federal work is not in today\'s cap');
  const up = await call('PATCH', '/api/clients/modesto-cove-church', { headers: TEAM, body: { applications: [{ id: 'a1', program: 'CSNSGP', cycle: '2026-27' }, { id: 'a2', program: 'NSGP-S', cycle: 'FY2027', status: 'active' }] } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  st = await call('GET', '/api/clients/modesto-cove-church/status', { headers: TEAM });
  assert.equal(st.data.budget.cap, 450000);
  assert.equal((await call('PATCH', '/api/clients/modesto-cove-church', { headers: TEAM, body: { applications: [{ program: 'NSGP-IL' }] } })).status, 400);
  assert.equal((await call('PATCH', '/api/clients/modesto-cove-church', { headers: TEAM, body: { applications: [{ program: 'NSGP-S', sites: [4] }] } })).status, 400);
  const html = renderClientPage({ client: { slug: 'modesto-cove-church', token: 't', name: 'M', state: 'CA', applications: up.data.applications.map(({ id, program, cycle, sites, status }) => ({ id, program, cycle, sites, status })) }, stateConfig: {}, existing: {} });
  assert.match(html, /APPLICATIONS=\[\{"id":"a1","program":"CSNSGP"/);
  const legacy = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Legacy Two Site Church', state: 'CA' } });
  await call('PUT', '/api/clients/legacy-two-site-church/answers', { headers: TEAM, body: { answers: { loc1_programs: 'Federal + State', loc2_name: 'Annex', loc2_programs: 'State Program' } } });
  st = await call('GET', '/api/clients/legacy-two-site-church/status', { headers: TEAM });
  assert.equal(st.data.applications_set, false);
  assert.deepEqual(st.data.applications.map(a => [a.program, a.sites.join(','), a.derived]), [['NSGP', '1', true], ['CSNSGP', '1,2', true]]);
  assert.deepEqual(legacy.data.applications, []);
  for (const slug of ['modesto-cove-church', 'legacy-two-site-church']) await call('PATCH', `/api/clients/${slug}`, { headers: TEAM, body: { status: 'cancelled' } });
});
await check('wish lists: one per application, keyed wl_<id>_ after the first, each against its own caps', async () => {
  const r = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Two List Church', state: 'CA', applications: [{ program: 'CSNSGP', cycle: '2026-27' }, { program: 'NSGP-S', cycle: 'FY2027', status: 'planned' }] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const seed = await call('PUT', '/api/clients/two-list-church/answers', { headers: TEAM, body: { answers: {
    wl_f1_vehicle_bollards_int: '1', wl_f1_vehicle_bollards_cost: '$100,000',
    wl_a2_f1_vehicle_bollards_int: '1', wl_a2_f1_vehicle_bollards_cost: '$150,000', wl_a2_f1_ma_on: 'off',
  } } });
  assert.equal(seed.status, 200, JSON.stringify(seed.data));
  const bad = await call('PUT', '/api/clients/two-list-church/answers', { headers: TEAM, body: { answers: { wl_a2_f1_not_a_thing_int: '1', wl_a1_f1_vehicle_bollards_int: '1' } } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.data.unknown_keys.sort(), ['wl_a1_f1_vehicle_bollards_int', 'wl_a2_f1_not_a_thing_int']);
  const st = await call('GET', '/api/clients/two-list-church/status', { headers: TEAM });
  assert.equal(st.data.wish_lists.length, 2);
  const [csn, fed] = st.data.wish_lists;
  assert.deepEqual([csn.application, csn.budget.requested, csn.budget.cap, csn.prioritized], ['a1', 105000, 250000, 1]);
  assert.deepEqual([fed.application, fed.budget.requested, fed.budget.cap, fed.facilities[0].budget.cap], ['a2', 150000, 200000, 200000]);
  assert.equal(st.data.budget.requested, 105000, 'the planned list stays out of the headline budget');
  const ans = await call('GET', '/api/clients/two-list-church/answers', { headers: TEAM });
  const row = ans.data.answers.find(a => a.key === 'wl_a2_f1_vehicle_bollards_cost');
  assert.equal(row.section, 'Wish List (NSGP-S FY2027) — Facility 1');
  const sect = await call('GET', `/api/clients/two-list-church/answers?section=${encodeURIComponent('Wish List (NSGP-S FY2027) — Facility 1')}`, { headers: TEAM });
  assert.equal(sect.data.count, 3);
  // Dropping a1 and adding a new application must not hand it a1's old keys.
  const re = await call('PATCH', '/api/clients/two-list-church', { headers: TEAM, body: { applications: [{ id: 'a2', program: 'NSGP-S', cycle: 'FY2027' }, { program: 'NSGP-UA', cycle: 'FY2027' }] } });
  assert.deepEqual(re.data.applications.map(a => a.id), ['a2', 'a3']);
  const page = renderClientPage({ client: { slug: 'two-list-church', token: 't', name: 'T', state: 'CA', applications: re.data.applications }, stateConfig: {}, existing: {} });
  assert.match(page, /"per_site":200000/);
  await call('PATCH', '/api/clients/two-list-church', { headers: TEAM, body: { status: 'cancelled' } });
});
await check('array arguments handed over as JSON text are taken as arrays (some MCP clients do this)', async () => {
  const r = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Json Args Church', state: 'CA' } });
  assert.equal(r.status, 201);
  const up = await call('PATCH', '/api/clients/json-args-church', { headers: TEAM, body: {
    applications: JSON.stringify([{ program: 'CSNSGP', cycle: '2026-27', sites: [1] }]),
    add_contacts: JSON.stringify([{ name: 'Pat Lee', email: 'pat@json.example', role: 'Exec' }]),
  } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.deepEqual(up.data.applications.map(a => a.label), ['CSNSGP 2026-27']);
  assert.ok(up.data.contacts.some(c => c.email === 'pat@json.example'));
  const drop = await call('PATCH', '/api/clients/json-args-church', { headers: TEAM, body: { remove_document_keys: JSON.stringify(['up_site_map']) } });
  assert.ok(!drop.data.documents.some(d => d.key === 'up_site_map'));
  assert.equal((await call('PATCH', '/api/clients/json-args-church', { headers: TEAM, body: { applications: 'not json' } })).status, 400);
  await call('PATCH', '/api/clients/json-args-church', { headers: TEAM, body: { status: 'cancelled' } });
});
await check('checklist: prep shared, wish list and submission repeated per application', async () => {
  const r = await call('POST', '/api/clients', { headers: TEAM, body: { name: 'Split List Church', state: 'CA', applications: [{ program: 'CSNSGP', cycle: '2026-27' }, { program: 'NSGP-S', cycle: 'FY2027' }] } });
  assert.equal(r.status, 201);
  const seed = await call('PUT', '/api/clients/split-list-church/answers', { headers: TEAM, body: { answers: {
    chk_status_kickoff_call: 'Completed', chk_status_sam_gov_uei_registration: 'Not applicable',
    chk_due_submit_application: '11/7/2026', chk_a2_due_submit_application: '5/1/2027', chk_a2_status_wish_list_ideation_per_location: 'Completed',
  } } });
  assert.equal(seed.status, 200, JSON.stringify(seed.data));
  assert.equal((await call('PUT', '/api/clients/split-list-church/answers', { headers: TEAM, body: { answers: { chk_a2_status_nope: 'Completed' } } })).status, 400);
  const st = await call('GET', '/api/clients/split-list-church/status', { headers: TEAM });
  const items = st.data.checklist.items;
  assert.equal(items.length, 34, 'fourteen shared tasks plus ten per application');
  assert.equal(items.filter((i) => i.application === null).length, 14);
  assert.deepEqual([...new Set(items.filter((i) => i.application).map((i) => i.application_label))], ['CSNSGP 2026-27', 'NSGP-S FY2027']);
  assert.equal(items.find((i) => i.application === 'a1' && i.stem === 'submit_application').due, '11/7/2026');
  assert.equal(items.find((i) => i.application === 'a2' && i.stem === 'submit_application').due, '5/1/2027');
  assert.deepEqual([st.data.checklist.completed, st.data.checklist.not_applicable, st.data.checklist.total], [2, 1, 33]);
  const list = (await call('GET', '/api/clients?status=active', { headers: TEAM })).data.find((c) => c.slug === 'split-list-church');
  assert.deepEqual([list.checklist.completed, list.checklist.total, list.checklist.not_applicable], [2, 33, 1]);
  const ans = await call('GET', '/api/clients/split-list-church/answers', { headers: TEAM });
  assert.equal(ans.data.answers.find((a) => a.key === 'chk_a2_due_submit_application').section, 'Checklist (NSGP-S FY2027)');
  await call('PATCH', '/api/clients/split-list-church', { headers: TEAM, body: { status: 'cancelled' } });
});
await check('contacts: reference side is read-only for the client; the client can edit their own people', async () => {
  const r = await call('PATCH', `/api/clients/${created.slug}`, { headers: TEAM, body: { add_reference_contacts: [{ name: 'eGrants help desk', role: 'Texas SAA', email: 'egrants@gov.texas.gov', phone: '(512) 463-1919' }], add_contacts: [{ name: 'Pat Lee', role: 'Exec Pastor', email: 'pat@example.org' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const view = await call('GET', `/api/intake/${created.slug}/contacts`, { headers: { 'X-Intake-Token': token() } });
  assert.equal(view.data.reference.length, 1);
  assert.ok(!view.data.client.some(x => x.email === 'egrants@gov.texas.gov'));
  const edit = await call('PUT', `/api/intake/${created.slug}/contacts`, { headers: { 'X-Intake-Token': token() }, body: { email: 'pat@example.org', name: 'Pat Lee', role: 'Executive Pastor', phone: '555-0100' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.client.find(x => x.email === 'pat@example.org').phone, '555-0100');
  const refuse = await call('PUT', `/api/intake/${created.slug}/contacts`, { headers: { 'X-Intake-Token': token() }, body: { email: 'egrants@gov.texas.gov', name: 'x' } });
  assert.equal(refuse.status, 400);
  const del = await call('DELETE', `/api/intake/${created.slug}/contacts?email=egrants@gov.texas.gov`, { headers: { 'X-Intake-Token': token() } });
  assert.equal(del.status, 400);
});
// ── Drive mirror against a fake Google ──
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'npsa-intake@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const fake = express();
const seenDrive = [];
fake.use(express.raw({ type: () => true, limit: '30mb' }));
fake.post('/token', (req, res) => {
  const p = new URLSearchParams(req.body.toString());
  const [h, c, sig] = String(p.get('assertion')).split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), privateKey, Buffer.from(sig, 'base64url'));
  if (!ok || claims.iss !== SA.client_email || !claims.scope.includes('auth/drive')) return res.status(401).json({ error: 'invalid_grant' });
  res.json({ access_token: 'fake-token', expires_in: 3600 });
});
fake.post('/upload', (req, res) => {
  if (req.get('authorization') !== 'Bearer fake-token') return res.status(401).json({ error: { message: 'no token' } });
  const body = req.body.toString('latin1');
  const meta = JSON.parse(body.match(/\r\n\r\n(\{.*?\})\r\n/s)[1]);
  seenDrive.push({ meta, size: req.body.length, ct: req.get('content-type') });
  if (meta.parents[0] === 'FAIL') return res.status(403).json({ error: { message: 'insufficientFilePermissions' } });
  res.json({ id: 'drv' + seenDrive.length, name: meta.name, webViewLink: `https://drive.google.com/file/d/drv${seenDrive.length}/view` });
});
const fakeServer = await new Promise(resolve => { const s = fake.listen(0, () => resolve(s)); });
const fakeOrigin = `http://127.0.0.1:${fakeServer.address().port}`;
const driveOpts = { credentials: { ...SA, token_uri: `${fakeOrigin}/token` }, tokenUrl: `${fakeOrigin}/token`, uploadUrl: `${fakeOrigin}/upload` };

await check('drive.js signs a JWT the token endpoint accepts and posts a multipart upload', async () => {
  assert.equal(await accessToken(driveOpts), 'fake-token');
  const r = await uploadToDrive({ ...driveOpts, folderId: 'PHASE2', filename: 'm.pdf', mime: 'application/pdf', content: PDF });
  assert.equal(r.id, 'drv1');
  assert.match(r.url, /drive\.google\.com/);
  assert.deepEqual(seenDrive[0].meta, { name: 'm.pdf', parents: ['PHASE2'] });
  assert.match(seenDrive[0].ct, /^multipart\/related; boundary=/);
  await assert.rejects(uploadToDrive({ ...driveOpts, folderId: '', filename: 'm.pdf', mime: 'application/pdf', content: PDF }), /no upload folder/);
  await assert.rejects(uploadToDrive({ ...driveOpts, folderId: 'FAIL', filename: 'm.pdf', mime: 'application/pdf', content: PDF }), /insufficientFilePermissions/);
  await assert.rejects(accessToken({ ...driveOpts, credentials: { ...driveOpts.credentials, private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) } }), /token request failed/);
});

await check('with a mirror configured the upload lands in Drive and the link is recorded; a Drive failure keeps the upload', async () => {
  const app4 = express();
  app4.use(['/api/clients', '/api/intake'], express.json({ limit: '2mb' }));
  const store4 = createMemoryStore();
  registerIntake(app4, { store: store4, internalKey: INTERNAL, publicBase: BASE, drive: { upload: o => uploadToDrive({ ...driveOpts, ...o }) } });
  const s4 = await new Promise(resolve => { const s = app4.listen(0, () => resolve(s)); });
  const o4 = `http://127.0.0.1:${s4.address().port}`;
  const mk = async (name, folder) => {
    const c = await (await fetch(`${o4}/api/clients`, { method: 'POST', headers: { ...TEAM, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state: 'FL', upload_folder_id: folder }) })).json();
    return { slug: c.slug, t: new URL(c.intake_url).searchParams.get('t') };
  };
  const good = await mk('Mirror Church', 'PHASE2-GOOD');
  const r = await fetch(`${o4}/api/intake/${good.slug}/upload`, { method: 'POST', headers: { 'X-Intake-Token': good.t }, body: multipart('up_mission', 'mission.pdf', PDF, 'application/pdf') });
  const rBody = await r.text();
  assert.equal(r.status, 200, rBody);
  const d = JSON.parse(rBody);
  assert.match(d.drive_url, /drive\.google\.com\/file\/d\/drv/);
  assert.equal(seenDrive[seenDrive.length - 1].meta.parents[0], 'PHASE2-GOOD');
  const list = await (await fetch(`${o4}/api/clients/${good.slug}/uploads`, { headers: TEAM })).json();
  assert.equal(list.uploads[0].drive_url, d.drive_url);
  const ans = await (await fetch(`${o4}/api/clients/${good.slug}/answers?section=uploads`, { headers: TEAM })).json();
  assert.ok(ans.answers[0].value.includes(d.drive_url), 'answer carries the Drive link');

  const bad = await mk('No Folder Church', 'FAIL');
  const warned = [];
  const origWarn = console.warn; console.warn = (...a) => warned.push(a.join(' '));
  let r2;
  try { r2 = await fetch(`${o4}/api/intake/${bad.slug}/upload`, { method: 'POST', headers: { 'X-Intake-Token': bad.t }, body: multipart('up_mission', 'mission.pdf', PDF, 'application/pdf') }); }
  finally { console.warn = origWarn; }
  assert.equal(r2.status, 200, 'client never sees the Drive failure');
  const d2 = await r2.json();
  assert.equal(d2.drive_url, null);
  assert.match(warned.join('\n'), /drive mirror failed .*insufficientFilePermissions/);
  const dl = await fetch(`${o4}/api/clients/${bad.slug}/uploads/${d2.id}`, { headers: TEAM });
  assert.equal(dl.status, 200, 'the Postgres copy stands');
  s4.close();
});
fakeServer.close();

await check('with no store the team routes say so and the page is a 503', async () => {
  const app2 = express(); app2.use(express.json());
  registerIntake(app2, { store: null, internalKey: INTERNAL, publicBase: BASE });
  const s2 = await new Promise(resolve => { const s = app2.listen(0, () => resolve(s)); });
  const o2 = `http://127.0.0.1:${s2.address().port}`;
  const r = await fetch(`${o2}/api/clients`, { headers: TEAM });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Storage not configured/);
  assert.equal((await fetch(`${o2}/client/anyone?t=x`)).status, 503);
  s2.close();
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll intake checks passed');
process.exit(failures ? 1 : 0);
