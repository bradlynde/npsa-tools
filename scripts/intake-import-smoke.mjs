#!/usr/bin/env node
/*
 * Import script check.
 *
 * Builds a small .xlsx in memory the way Google Sheets exports one (a zip of XML
 * with a shared-string table), with a Registry tab and two client tabs, then:
 *
 *   1. reads it back with the script's own workbook reader (shared strings,
 *      inline strings, numbers, booleans, empty cells, a hidden fifth column);
 *   2. turns it into clients with their non-empty answers, skipping the demo
 *      client and tolerating a client with no tab;
 *   3. runs the import against a fake /api/clients on a throwaway express app:
 *      slug and token preserved, statuses applied, keys the form does not render
 *      skipped and reported, a 409 on re-run treated as "already there" with the
 *      answers still written, and a dry run that sends nothing;
 *   4. runs the CLI in --dry-run mode against the file on disk.
 *
 *   node scripts/intake-import-smoke.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { readWorkbook, extractClients, runImport } from './intake-import.mjs';

// ── A tiny xlsx writer (stored entries, real CRCs) ────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameB = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nameB, data); central.push(cd, nameB); offset += local.length + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = i => { let s = ''; i++; while (i) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };

/** rows: arrays of cells; a cell is a string (shared), {inline}, a number, {date: serial}, a boolean, or null. */
function workbook(sheets) {
  const shared = []; const sidx = s => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const files = {};
  const names = Object.keys(sheets);
  names.forEach((name, n) => {
    const rowsXml = sheets[name].map((row, r) => {
      const cells = row.map((v, c) => {
        if (v === null || v === undefined) return '';
        const ref = `${col(c)}${r + 1}`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
        if (typeof v === 'object' && 'datetime' in v) return `<c r="${ref}" s="2"><v>${v.datetime}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
        if (typeof v === 'object') return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`;
        return `<c r="${ref}" t="s"><v>${sidx(v)}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${shared.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  files['xl/styles.xml'] = '<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy h:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>';
  files['[Content_Types].xml'] = '<?xml version="1.0"?><Types/>';
  return zip(files);
}

const HEADER = ['Section', 'Question', 'Answer', 'Updated', '_key'];
const BOOK = workbook({
  Registry: [
    ['Client slug', 'Name', 'State', 'Token', 'Created', 'Upload folder ID'],
    ['demo-client', 'Demo Client', 'IL', 'demo123', 45900, ''],
    ['new-life-ky', 'New Life Church', 'ky', 'ABC123DEF456', 45900.5, '1Lt5N4-phase2'],
    ['masters-academy', "The Master's Academy", 'FL', 'ffeeddccbbaa', 45901, ''],
    ['no-tab-church', 'No Tab Church', 'TX', '', null, ''],
  ],
  'R · new-life-ky': [
    HEADER,
    ['1. Applicant Information', '1.1.1 Name', 'Phil Yeoman', 45910, 'q_1_1_1'],
    ['1. Applicant Information', '1.3.7 Number of full-time employees', 12, 45910, 'q_1_3_7'],
    ['1. Applicant Information', '1.1.2 Title', '', null, 'q_1_1_2'],
    ['2. Identity', '2.1 Ideology', { inline: 'Reformed & <evangelical> "quotes"' }, 45911, 'q_2_1'],
    ['Checklist', 'State registration — status', 'In progress', 45912, 'chk_status_state_reg'],
    ['Checklist', 'State registration — due date', { date: 46268 }, { datetime: 45912.75 }, 'chk_due_state_reg'],
    ['Wish List — Facility 1', 'Vehicle Bollards — Est. cost', 46268, 45912, 'wl_f1_vehicle_bollards_cost'],
    ['Other', 'chk_note_10', 'stale seed', 45912, 'chk_note_10'],
    ['Other', 'chk_who_investment_justification', 'me', 45912, 'chk_who_investment_justification'],
    ['About this response', 'Submission status', 'Submitted 8/30/2026 by Phil', 45913, '_status'],
    ['Locations', 'Site 1 — Historic?', true, 45913, 'loc1_historic'],
    ['Uploads', 'Mission statement', '', null, 'up_mission'],
  ],
  "R · masters-academy": [
    HEADER,
    ['1. Applicant Information', '1.1.1 Name', 'Jade Matthews', 45905, 'q_1_1_1'],
  ],
});

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

let sheets, clients;
await check('the workbook reader returns every tab with strings, numbers, booleans, inline text and empties', async () => {
  sheets = readWorkbook(BOOK);
  assert.deepEqual(Object.keys(sheets).sort(), ['R · masters-academy', 'R · new-life-ky', 'Registry']);
  assert.equal(sheets.Registry[2][1], 'New Life Church');
  const nl = sheets['R · new-life-ky'];
  assert.equal(nl[1][4], 'q_1_1_1');
  assert.equal(nl[2][2], '12', 'number as string');
  assert.equal(nl[3][2], '', 'empty answer');
  assert.equal(nl[4][2], 'Reformed & <evangelical> "quotes"', 'inline string unescaped');
  assert.equal(nl[11][2], 'TRUE', 'boolean');
  assert.equal(nl[6][2], '9/3/2026', 'date-styled serial becomes M/D/YYYY');
  assert.equal(nl[6][3], '9/13/2025', 'datetime-styled serial too');
  assert.equal(nl[7][2], '46268', 'an unstyled number stays a number');
});

await check('extractClients keeps slug, token, folder and only non-empty answers, skipping the demo client', async () => {
  clients = extractClients(sheets);
  assert.deepEqual(clients.map(c => c.slug), ['new-life-ky', 'masters-academy', 'no-tab-church']);
  const nl = clients[0];
  assert.equal(nl.state, 'KY', 'state upper-cased');
  assert.equal(nl.token, 'abc123def456', 'token lower-cased');
  assert.equal(nl.upload_folder_id, '1Lt5N4-phase2');
  assert.equal(nl.rows, 12);
  assert.deepEqual(Object.keys(nl.answers), ['q_1_1_1', 'q_1_3_7', 'q_2_1', 'chk_status_state_reg', 'chk_due_state_reg', 'wl_f1_vehicle_bollards_cost', 'chk_note_10', 'chk_who_investment_justification', '_status', 'loc1_historic']);
  assert.equal(nl.answers.chk_due_state_reg, '9/3/2026');
  assert.equal(nl.answers.q_1_3_7, '12');
  assert.equal(clients[2].has_tab, false);
  assert.equal(clients[2].token, '');
});

// ── fake API ──
const received = [];
const existing = new Set();
const app = express(); app.use(express.json({ limit: '2mb' }));
app.post('/api/clients', (req, res) => { received.push({ m: 'POST', p: req.path, b: req.body }); if (existing.has(req.body.slug)) return res.status(409).json({ error: 'slug taken' }); existing.add(req.body.slug); res.status(201).json({ slug: req.body.slug }); });
app.get('/api/clients/:slug', (req, res) => res.json({ slug: req.params.slug, notes: 'Imported from the Apps Script registry on 2026-09-03.' }));
app.patch('/api/clients/:slug', (req, res) => { received.push({ m: 'PATCH', p: req.path, b: req.body }); res.json({ ok: true }); });
app.put('/api/clients/:slug/answers', (req, res) => { received.push({ m: 'PUT', p: req.path, b: req.body }); res.json({ ok: true, written: Object.keys(req.body.answers).length }); });
const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
const catalogKeys = ['q_1_1_1', 'q_1_1_2', 'q_1_3_7', 'q_2_1', 'chk_status_state_reg', 'chk_due_state_reg', 'wl_f1_vehicle_bollards_cost', '_status', 'loc1_historic', 'up_mission'];
const quiet = () => {};

await check('a dry run reports everything and sends nothing', async () => {
  const report = await runImport(clients, { api, catalogKeys, dryRun: true, statuses: { 'masters-academy': 'cancelled' }, log: quiet });
  assert.equal(received.length, 0);
  assert.equal(report[0].answers, 8);
  assert.deepEqual(report[0].unknown, ['chk_note_10', 'chk_who_investment_justification']);
  assert.equal(report[1].status, 'cancelled');
  assert.match(report[2].warnings.join(' '), /no answers tab/);
  assert.match(report[2].warnings.join(' '), /no token/);
});

await check('the import creates clients with slug and token kept, applies statuses, and writes only known keys', async () => {
  const report = await runImport(clients, { api, catalogKeys, statuses: { 'masters-academy': 'cancelled' }, log: quiet });
  assert.deepEqual(report.map(r => [r.created, r.existed, r.written]), [[true, false, 8], [true, false, 1], [true, false, 0]]);
  const post = received.find(x => x.m === 'POST' && x.b.slug === 'new-life-ky');
  const { notes, ...rest } = post.b;
  assert.deepEqual(rest, { slug: 'new-life-ky', name: 'New Life Church', state: 'KY', status: 'active', upload_folder_id: '1Lt5N4-phase2', token: 'abc123def456' });
  assert.match(notes, /Keys the form does not render/);
  assert.match(notes, /- chk_note_10: stale seed\n- chk_who_investment_justification: me/);
  assert.match(received.find(x => x.m === 'POST' && x.b.slug === 'masters-academy').b.notes, /^Imported from the Apps Script registry on \d{4}-\d{2}-\d{2}\.$/);
  const noTok = received.find(x => x.m === 'POST' && x.b.slug === 'no-tab-church');
  assert.equal(noTok.b.token, undefined, 'no empty token sent');
  assert.equal(received.find(x => x.m === 'POST' && x.b.slug === 'masters-academy').b.status, 'cancelled');
  const put = received.find(x => x.m === 'PUT' && x.p === '/api/clients/new-life-ky/answers');
  assert.equal(put.b.by, 'import');
  assert.deepEqual(Object.keys(put.b.answers).sort(), ['_status', 'chk_due_state_reg', 'chk_status_state_reg', 'loc1_historic', 'q_1_1_1', 'q_1_3_7', 'q_2_1', 'wl_f1_vehicle_bollards_cost']);
  assert.equal(put.b.answers.chk_due_state_reg, '9/3/2026');
  assert.equal(put.b.answers.q_2_1, 'Reformed & <evangelical> "quotes"');
  assert.ok(!received.some(x => x.m === 'PUT' && x.p.includes('no-tab-church')), 'nothing to write for a client without answers');
});

await check('a re-run treats 409 as already there and still writes the answers', async () => {
  received.length = 0;
  const report = await runImport(clients.slice(0, 1), { api, catalogKeys, log: quiet });
  assert.deepEqual([report[0].created, report[0].existed, report[0].written], [false, true, 8]);
  assert.equal(received.filter(x => x.m === 'PUT').length, 1);
  assert.match(received.find(x => x.m === 'PATCH').b.notes, /^Imported from the Apps Script registry/, 'import-written notes refreshed on re-run');
});

await check('the CLI dry run reads the file and uses the repo catalog without a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'intake-import-'));
  const file = join(dir, 'registry.xlsx');
  writeFileSync(file, BOOK);
  const out = execFileSync(process.execPath, [new URL('./intake-import.mjs', import.meta.url).pathname, file, '--dry-run', '--status', 'masters-academy=cancelled', '--skip', 'no-tab-church'], { env: { ...process.env, MCP_API_KEY: '' }, encoding: 'utf8' });
  assert.match(out, /2 client\(s\) to import \(dry run\)/);
  assert.match(out, /new-life-ky: New Life Church \(KY\) status=active answers=8 skipped=2/);
  assert.match(out, /not on the form, kept in the client's notes: chk_note_10, chk_who_investment_justification/);
  assert.match(out, /masters-academy: .* status=cancelled/);
  assert.match(out, /Dry run: 2 client\(s\), 9 answer\(s\) would be written, 2 key\(s\) kept in notes instead/);
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll import checks passed');
process.exit(failures ? 1 : 0);
