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
 *      answers with a sentence until uploads exist, and a route without the
 *      template answers 503 rather than serving something half-filled.
 *
 *   node scripts/intake-smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import { registerIntake, createMemoryStore, renderClientPage, QUESTIONS, normaliseAnswers, slugify, healToken } from '../server/intake.js';

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
  renderPage: ({ client, stateConfig, existing }) => { rendered = { client, stateConfig, existing }; return `<html>page for ${client.slug}</html>`; },
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
await check('catalog is served with 592 questions and the section list', async () => {
  const r = await call('GET', '/api/intake/questions', { headers: TEAM });
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 592);
  assert.equal(QUESTIONS.length, 592);
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
  assert.equal(created.contacts.length, 2);
  assert.equal(created.contacts[0].email, 'pat@trinity.org');
  assert.equal(created.contacts[0].is_primary, true);
  assert.equal(created.contacts[0].added_by, 'npsa:abcd1234');
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
  assert.deepEqual(c.data.checklist, { completed: 1, total: 24 });
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
  assert.deepEqual(r.data.contacts.map(c => c.email), ['pat@trinity.org', 'sam@trinity.org']);
  const missing = await call('PATCH', '/api/clients/nobody', { headers: TEAM, body: { phase: 2 } });
  assert.equal(missing.status, 404);
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
});
// ── 6. The page ───────────────────────────────────────────────────────────────
await check('renderClientPage fills every placeholder and escapes a script-closing value', async () => {
  const html = renderClientPage({
    client: { slug: 'evil-co', token: 'abc123def456', name: 'Evil </script><img src=x onerror=alert(1)> Co', state: 'KY' },
    stateConfig: { saa: 'KOHS', registration: ['x — hard gate'], programs: [], perSiteCap: '', stateCap: '' },
    existing: { q_1_1_1: 'line\u2028break', q_2_1: '<b>bold</b>' },
  });
  assert.ok(html && html.length > 200000, 'template rendered');
  assert.ok(!/\{\{\w+\}\}/.test(html), 'no placeholder left');
  assert.ok(html.includes('var CLIENT="evil-co",TOKEN="abc123def456"'));
  assert.ok(html.includes('CLIENT_NAME="Evil \\u003c/script\\u003e'), 'script close escaped');
  assert.ok(!html.includes('</script><img'), 'raw closing tag never appears');
  assert.ok(html.includes('"q_1_1_1":"line\\u2028break"'), 'line separator escaped');
  assert.ok(html.includes('API_BASE=""'));
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
  const up = await fetch(`${o3}/api/intake/page-test-church/upload`, { method: 'POST', headers: { 'X-Intake-Token': t } });
  assert.equal(up.status, 503);
  assert.match((await up.json()).error, /email the file/);
  assert.equal((await fetch(`${o3}/api/intake/page-test-church/upload`, { method: 'POST' })).status, 401);
  s3.close();
});
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
