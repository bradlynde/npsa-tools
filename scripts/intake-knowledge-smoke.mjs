#!/usr/bin/env node
/*
 * The client intake page reading the grant knowledge base (server/knowledge.js).
 *
 * Builds a snapshot from a handful of records and checks what a client would see:
 *
 *   1. Trust. Only verified records reach a client; a field changed and not yet
 *      confirmed drops out as unknown; a verified record under an unverified
 *      program drops with it.
 *   2. Uploads. The US baseline in the state's own wording, then what the state
 *      adds; a state program with its own list (California's CSNSGP) replaces it;
 *      a program_track that names the program counts before applications are set.
 *   3. Registration. Federal steps for every client, a state program's steps only
 *      for a client applying to it.
 *   4. Caps. The state's own federal per-site cap (Kansas), a "State Program" site
 *      drawing on the larger of two programs the state awards only one of (New
 *      Jersey), dormant programs left out.
 *   5. Reference contacts. A new client starts with the SAA's verified contacts,
 *      not the ones with no email or a warning, and reference_contacts: false opts out.
 *   6. The sync. A refresh after a knowledge write, and no snapshot at all (the
 *      JSON files) when the knowledge base is empty.
 *
 *   node scripts/intake-knowledge-smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import { buildKnowledge, setKnowledgeSnapshot, knowledgeSnapshot, startKnowledgeSync, trustedRecords } from '../server/knowledge.js';
import { documentsFor, stateConfig, stateProgram, capsFor, programsFor, federalSiteCap, referenceContactsFor, registerIntake, createMemoryStore } from '../server/intake.js';

process.env.MCP_API_KEYS = 'team-key';
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${String(err.stack || err.message).split('\n').slice(0, 3).join('\n      ')}`); }
}

let id = 0;
const rec = (jurisdiction, kind, key, data, extra = {}) => ({
  id: ++id, jurisdiction, kind, key, data, parent_id: null, status: 'verified', unverified_fields: [], sort_order: id,
  verified_at: '2026-09-01T00:00:00Z', archived_at: null, ...extra,
});
const under = (parent, kind, key, data, extra = {}) => rec(parent.jurisdiction, kind, key, data, { parent_id: parent.id, ...extra });
const req = (p, key, data, extra) => under(p, 'requirement', key, { owner: 'client', ...data }, extra);

const records = [];
const add = r => { records.push(r); return r; };

// US baseline
add(rec('US', 'jurisdiction', 'US', { name: 'United States', saa: 'FEMA' }));
const us = add(rec('US', 'program', 'NSGP', { name: 'NSGP', type: 'federal', status: 'active', cap_per_location: 200000, locations_max: 3 }));
add(req(us, 'sam_uei', { req_type: 'registration', label: 'SAM.gov registration + active UEI', hard_gate: true, lead_time_days: 28 }));
add(req(us, 'mission_letterhead', { req_type: 'document', label: 'Mission statement', upload_key: 'up_mission', client_label: 'Mission statement on letterhead', client_hint: 'PDF / DOCX', task_stem: 'mission_statement_on_letterhead' }));
add(req(us, 'vuln_assessment', { req_type: 'document', label: 'VA', upload_key: 'up_va', client_label: 'Vulnerability assessment (if you have one)', client_hint: 'PDF', ready_label: 'VA received' }));
add(req(us, 'bios_resumes', { req_type: 'document', label: 'Bios', upload_key: 'up_bios', client_label: 'Leadership bios' }, { status: 'unverified' }));

// Texas: a state-added upload, a state registration with its note, a state wording of the VA row
add(rec('TX', 'jurisdiction', 'TX', { name: 'Texas', saa: 'Office of the Governor, Public Safety Office', saa_short: 'OOG PSO' }));
const txS = add(rec('TX', 'program', 'NSGP-S', { name: 'NSGP-S', type: 'federal', status: 'active', locations_max: 3 }));
add(rec('TX', 'program', 'NSGP-UA', { name: 'NSGP-UA', type: 'federal', status: 'active', inherits_from: 'NSGP-S' }));
add(req(txS, 'egrants', { req_type: 'registration', label: 'eGrants', client_label: 'Texas eGrants account', client_hint: 'Stage 1 in January', hard_gate: true, lead_time_days: 60 }));
add(req(txS, 'vuln_assessment', { req_type: 'document', label: 'VA (Texas)', client_hint: 'PDF · Texas form' }));
add(req(txS, 'tx_payee_forms', { req_type: 'document', label: 'Payee forms', upload_key: 'up_tx_payee', client_label: 'Texas payee forms' }));
add(req(txS, 'draft_resolution', { req_type: 'document', label: 'Draft resolution', upload_key: 'up_draft' }, { status: 'unverified' }));
add(rec('TX', 'contact', 'helpdesk', { org: 'eGrants help desk', email: 'eGrants@gov.texas.gov', phone: '(512) 463-1919', contact_kind: 'saa', is_primary: true }));
add(rec('TX', 'contact', 'nobody', { org: 'Main line', phone: '(512) 000-0000', contact_kind: 'saa' }));
add(rec('TX', 'contact', 'gone', { name: 'Old PM', email: 'old@gov.texas.gov', contact_kind: 'program', warning: 'no longer listed' }));
add(rec('TX', 'contact', 'maybe', { name: 'Unconfirmed', email: 'maybe@gov.texas.gov', contact_kind: 'saa' }, { status: 'unverified' }));

// Kansas: its own lower federal cap
add(rec('KS', 'jurisdiction', 'KS', { name: 'Kansas', saa: 'Kansas Highway Patrol', saa_short: 'KHP' }));
add(rec('KS', 'program', 'NSGP-S', { name: 'NSGP-S', type: 'federal', status: 'active', cap_per_location: 150000, locations_max: 3 }));

// New Jersey: two state programs, one award between them; one field changed and not confirmed
add(rec('NJ', 'jurisdiction', 'NJ', { name: 'New Jersey', saa: 'NJ Office of Homeland Security & Preparedness', saa_short: 'NJOHSP' }));
add(rec('NJ', 'program', 'NSGP-S', { name: 'NSGP-S', type: 'federal', status: 'active' }));
const the = add(rec('NJ', 'program', 'NJ-NSGP-THE', { name: 'NJ THE', type: 'state', status: 'active', cap_per_applicant: 100000, exclusive_with: ['NJ-NSGP-SP'] }));
add(rec('NJ', 'program', 'NJ-NSGP-SP', { name: 'NJ SP', type: 'state', status: 'active', cap_per_applicant: 20000, exclusive_with: ['NJ-NSGP-THE'] }));
add(req(the, 'portal', { req_type: 'registration', label: 'NJOHSP portal account', hard_gate: true }));

// California: CSNSGP carries its own upload list; FL: a dormant program; MD: a cap changed and not confirmed; OR: an unverified program
add(rec('CA', 'jurisdiction', 'CA', { name: 'California', saa: 'Cal OES' }));
add(rec('CA', 'program', 'NSGP-S', { name: 'NSGP-S', type: 'federal', status: 'active' }));
const cs = add(rec('CA', 'program', 'CSNSGP', { name: 'California State Nonprofit Security Grant Program', type: 'state', status: 'active', cap_per_location: 250000, cap_per_applicant: 500000 }));
add(req(cs, 'vuln_assessment', { req_type: 'document', label: 'Cal OES VA', upload_key: 'up_va', client_label: 'Cal OES Vulnerability Assessment Worksheet' }));
add(req(cs, 'proof_of_address', { req_type: 'document', label: 'Proof', upload_key: 'up_proof_address', client_label: 'Proof of ownership or lease' }));
add(rec('FL', 'jurisdiction', 'FL', { name: 'Florida', saa: 'FDEM' }));
add(rec('FL', 'program', 'FL-NSGP', { name: 'FL NSGP', type: 'state', status: 'dormant', cap_per_location: 150000 }));
add(rec('MD', 'jurisdiction', 'MD', { name: 'Maryland', saa: 'GOCPP' }));
add(rec('MD', 'program', 'PAHC', { name: 'PAHC', type: 'state', status: 'active', cap_per_applicant: 200000, pop_months: 12 }, { unverified_fields: ['cap_per_applicant'] }));
add(rec('OR', 'jurisdiction', 'OR', { name: 'Oregon', saa: 'OEM' }));
const orS = add(rec('OR', 'program', 'NSGP-S', { name: 'NSGP-S', type: 'federal', status: 'active', cap_per_location: 100000 }, { status: 'unverified' }));
add(req(orS, 'oem_form', { req_type: 'registration', label: 'OEM registration form', hard_gate: true }));

const kb = buildKnowledge(records, new Date('2026-09-21T12:00:00Z'));
setKnowledgeSnapshot(kb);

await check('only verified records reach a client, without their unconfirmed fields', () => {
  const trusted = trustedRecords(records);
  assert.ok(!trusted.some(r => r.status !== 'verified'));
  assert.ok(!trusted.some(r => r.jurisdiction === 'OR' && r.kind === 'requirement'), 'a verified step under an unverified program drops with it');
  assert.equal(kb.states.MD.programs[0].per_applicant, null, 'an unconfirmed cap is unknown');
  assert.equal(kb.states.MD.programs[0].name, 'PAHC', 'the rest of the record stands');
  assert.equal(stateConfig('MD').stateCap, 'PAHC: not published');
  assert.deepEqual(stateConfig('OR').registration.map(r => r.label), ['SAM.gov registration + active UEI'], 'only the baseline, which is verified');
  assert.equal(federalSiteCap('OR'), 200000, 'an unverified state cap does not lower the federal one');
});

await check('a federal client gets the baseline in the state\'s wording, then what the state adds', () => {
  const docs = documentsFor({ state: 'TX' });
  assert.deepEqual(docs.map(d => d.key), ['up_mission', 'up_va', 'up_tx_payee'], 'unverified rows (bios, the draft) are not asked for');
  const va = docs.find(d => d.key === 'up_va');
  assert.equal(va.label, 'Vulnerability assessment (if you have one)', 'the client wording stays the baseline\'s');
  assert.equal(va.hint, 'PDF · Texas form', 'the state\'s hint wins');
  assert.equal(va.ready, 'VA received');
  assert.equal(va.source, 'standard');
  assert.equal(docs.find(d => d.key === 'up_tx_payee').source, 'state');
  assert.equal(docs.find(d => d.key === 'up_mission').task, 'mission_statement_on_letterhead');
  assert.deepEqual(documentsFor({ state: 'TX', applications: [{ program: 'NSGP-UA', status: 'active' }] }).map(d => d.key), ['up_mission', 'up_va', 'up_tx_payee'], 'NSGP-UA takes NSGP-S\'s rows');
  const custom = [{ key: 'up_x', label: 'X', hint: '' }];
  assert.deepEqual(documentsFor({ state: 'TX', documents: custom }).map(d => d.key), ['up_x'], 'a list the team set still wins');
});

await check('a state program with its own list replaces the federal one, by application or by program_track', () => {
  const byApp = documentsFor({ state: 'CA', applications: [{ program: 'NSGP-S', status: 'active' }, { program: 'CSNSGP', status: 'active' }] });
  assert.deepEqual(byApp.map(d => [d.key, d.source]), [['up_va', 'program'], ['up_proof_address', 'program']]);
  assert.equal(byApp[0].label, 'Cal OES Vulnerability Assessment Worksheet');
  assert.deepEqual(documentsFor({ state: 'CA', program_track: '2026-27 CSNSGP' }).map(d => d.key), ['up_va', 'up_proof_address']);
  assert.deepEqual(documentsFor({ state: 'CA', program_track: 'California State Nonprofit Security Grant Program' }).map(d => d.key), ['up_va', 'up_proof_address']);
  assert.deepEqual(documentsFor({ state: 'CA', applications: [{ program: 'CSNSGP', status: 'withdrawn' }] }).map(d => d.key), ['up_mission', 'up_va'], 'a withdrawn application does not count');
});

await check('registration: federal steps for everyone, a state program\'s only for its applicants', () => {
  const tx = stateConfig('TX');
  assert.deepEqual(tx.registration, [
    { label: 'Texas eGrants account', hard_gate: true, note: 'Stage 1 in January' },
    { label: 'SAM.gov registration + active UEI', hard_gate: true },
  ], 'hard gates first, longest lead first');
  assert.equal(tx.saa, 'OOG PSO');
  assert.equal(tx.perSiteCap, '$200,000 per site · up to 3 sites');
  assert.equal(tx.stateCap, '—');
  assert.ok(!stateConfig('NJ').registration.some(r => /NJOHSP portal/.test(r.label)));
  assert.ok(stateConfig('NJ', ['NJ-NSGP-THE']).registration.some(r => r.label === 'NJOHSP portal account' && r.hard_gate));
});

await check('caps: a state\'s own federal cap, one award between exclusive programs, dormant ones out', () => {
  assert.equal(federalSiteCap('KS'), 150000);
  assert.equal(stateConfig('KS').federalSiteCap, 150000, 'the page gets it for its budget');
  assert.equal(capsFor('KS', [{ facility: 1, programs: 'Federal NSGP-S' }, { facility: 2, programs: '' }]).cap, 300000);
  assert.equal(programsFor('KS').find(p => p.code === 'NSGP-S').per_site, 150000);
  const nj = stateProgram('NJ');
  assert.equal(nj.acronym, 'NJ-NSGP-THE or NJ-NSGP-SP');
  assert.equal(nj.perApplicant, 100000, 'the larger of the two, not their sum');
  const caps = capsFor('NJ', [{ facility: 1, programs: 'Federal + State' }, { facility: 2, programs: 'Federal + State' }]);
  assert.equal(caps.state, 100000);
  assert.equal(caps.cap, 500000);
  assert.equal(stateProgram('FL'), null, 'a dormant program is nothing to apply to');
  assert.equal(capsFor('FL', [{ facility: 1, programs: 'Federal + State' }]).cap, 200000);
  assert.ok(programsFor('FL').some(p => p.code === 'FL-NSGP'), 'but an application can still name it (a past round)');
  const ca = capsFor('CA', [{ facility: 1, programs: 'Federal + State' }, { facility: 2, programs: 'Federal + State' }, { facility: 3, programs: 'Federal + State' }]);
  assert.equal(ca.state, 500000, 'California: $250,000 a site, held to $500,000');
});

await check('reference contacts: the SAA\'s verified ones with an email, none flagged', () => {
  assert.deepEqual(referenceContactsFor('TX'), [{ name: 'eGrants help desk', email: 'eGrants@gov.texas.gov', role: 'State administering agency', phone: '(512) 463-1919', side: 'reference' }]);
  assert.deepEqual(referenceContactsFor('KS'), []);
});

await check('a new client starts with them on the Contacts tab, unless told not to', async () => {
  const app = express(); app.use(express.json());
  const store = createMemoryStore();
  registerIntake(app, { store, internalKey: 'k', publicBase: 'https://x' });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/clients`;
  const post = body => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer team-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const one = await post({ name: 'Lone Star Chapel', state: 'TX', npsa_contacts: [], include_team: false });
  assert.equal(one.slug, "lone-star-chapel", JSON.stringify(one));
  const contacts = (await store.getClient(one.slug)).contacts;
  assert.deepEqual(contacts.filter(c => c.side === 'reference').map(c => c.email), ['egrants@gov.texas.gov']);
  const two = await post({ name: 'Quiet Chapel', state: 'TX', npsa_contacts: [], include_team: false, reference_contacts: false });
  assert.equal((await store.getClient(two.slug)).contacts.filter(c => c.side === 'reference').length, 0);
  const three = await post({ name: 'Named Chapel', state: 'TX', npsa_contacts: [], include_team: false, reference_contacts: [{ name: 'CISA PSA', email: 'psa@cisa.dhs.gov' }] });
  assert.deepEqual((await store.getClient(three.slug)).contacts.filter(c => c.side === 'reference').map(c => c.email), ['psa@cisa.dhs.gov']);
  const view = await fetch(`${url}/lone-star-chapel`, { headers: { Authorization: 'Bearer team-key' } }).then(r => r.json());
  assert.equal(view.saa, 'Office of the Governor, Public Safety Office');
  server.close();
});

await check('the sync: a refresh picks up a write, and an empty base leaves the JSON files in charge', async () => {
  const live = [...records];
  const store = { listRecords: async () => live };
  setKnowledgeSnapshot(null);
  const sync = startKnowledgeSync({ store, intervalMs: 3600000, log: { error() {} } });
  await sync.refresh();
  assert.equal(federalSiteCap('KS'), 150000);
  live.find(r => r.jurisdiction === 'KS' && r.kind === 'program').data = { name: 'NSGP-S', type: 'federal', status: 'active', cap_per_location: 175000 };
  await sync.refresh();
  assert.equal(federalSiteCap('KS'), 175000);
  store.listRecords = async () => { throw new Error('db down'); };
  await sync.refresh();
  assert.equal(federalSiteCap('KS'), 175000, 'a failed refresh keeps the last snapshot');
  sync.stop();
  setKnowledgeSnapshot(buildKnowledge([]));
  assert.equal(knowledgeSnapshot(), null, 'no records, no snapshot');
  assert.equal(stateConfig('TX').saa, 'OOG PSO', 'intake-state-config.json answers');
  assert.equal(federalSiteCap('KS'), 200000);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll intake knowledge checks passed');
process.exit(failures ? 1 : 0);
