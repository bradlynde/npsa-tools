#!/usr/bin/env node
/*
 * Import the Apps Script intake registry into the grant clients module.
 *
 * Input is an .xlsx export of the intake spreadsheet (File → Download → Microsoft
 * Excel in Google Sheets): the "Registry" tab (Client slug | Name | State | Token |
 * Created | Upload folder ID) and one "R · <slug>" tab per client (Section |
 * Question | Answer | Updated | _key — the last column is hidden in Sheets but
 * exports). Nothing else is needed; the workbook is read here with no dependency,
 * since an .xlsx is a zip of XML and Node ships zlib.
 *
 * Each client is created through POST /api/clients with its slug and token kept,
 * so the Apps Script redirect stub can send old links to the same place, and its
 * answers go through PUT /api/clients/:slug/answers with by = "import". Keys the
 * form no longer renders (old seeds that landed in the sheet's "Other" bucket) are
 * skipped and listed, never sent, since the route refuses a batch with unknown
 * keys. A client that already exists is not recreated; its answers are still
 * written, so the script can be re-run.
 *
 *   MCP_API_KEY=… LOE_API_URL=https://loe-generator-production.up.railway.app \
 *     node scripts/intake-import.mjs registry.xlsx --dry-run
 *   node scripts/intake-import.mjs registry.xlsx --status masters-academy=cancelled --only new-life-ky
 *
 * Options: --dry-run (read and report, send nothing) · --only a,b (these slugs) ·
 * --skip a,b · --status slug=cancelled,slug=closed (default active).
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ── .xlsx reading ─────────────────────────────────────────────────────────────

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + n);
    const ln = buf.readUInt16LE(local + 26), lm = buf.readUInt16LE(local + 28);
    const start = local + 30 + ln + lm;
    const data = buf.subarray(start, start + csize);
    files.set(name, method === 8 ? inflateRawSync(data) : method === 0 ? data : (() => { throw new Error(`unsupported zip method ${method} for ${name}`); })());
    p += 46 + n + m + k;
  }
  return files;
}

const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const textOf = xml => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** Sheets as { name → rows[][] } with every cell a string ('' when empty). */
export function readWorkbook(buf) {
  const files = unzip(buf);
  const get = name => { const f = files.get(name); if (!f) throw new Error(`${name} missing from workbook`); return f.toString('utf8'); };
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));
  const rels = Object.fromEntries([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => {
    const id = m[1].match(/\bId="([^"]+)"/)[1]; const target = m[1].match(/\bTarget="([^"]+)"/)[1];
    return [id, target.startsWith('/') ? target.slice(1) : `xl/${target}`];
  }));
  const sheets = {};
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescapeXml(m[1].match(/\bname="([^"]*)"/)[1]);
    const rid = m[1].match(/\br:id="([^"]+)"/)[1];
    const xml = get(rels[rid]);
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] || '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
        let v = '';
        if (type === 's') v = shared[parseInt(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '-1', 10)] ?? '';
        else if (type === 'inlineStr') v = textOf(inner);
        else if (type === 'b') v = (inner.match(/<v>([^<]*)<\/v>/)?.[1] === '1') ? 'TRUE' : 'FALSE';
        else v = unescapeXml(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '');
        if (ref) row[colIndex(ref + '1')] = v; else row.push(v);
      }
      rows.push(Array.from(row, x => x ?? ''));
    }
    sheets[name] = rows;
  }
  return sheets;
}

// ── Registry → clients ────────────────────────────────────────────────────────

const clean = v => String(v ?? '').trim();

/** Registry rows plus each client's non-empty answers, from the sheets. */
export function extractClients(sheets) {
  const reg = sheets.Registry;
  if (!reg) throw new Error('no "Registry" tab in the workbook');
  const tabFor = slug => sheets[`R · ${slug}`] || sheets[Object.keys(sheets).find(n => n.replace(/^R\s*[·\-]\s*/, '') === slug) || ''];
  const clients = [];
  for (const row of reg.slice(1)) {
    const slug = clean(row[0]);
    if (!slug || slug === 'demo-client') continue;
    const tab = tabFor(slug);
    const answers = {};
    let rows = 0;
    for (const r of (tab || []).slice(1)) {
      const key = clean(r[4]); const value = r[2] == null ? '' : String(r[2]);
      if (!key) continue;
      rows++;
      if (value.trim() !== '') answers[key] = value;
    }
    clients.push({
      slug, name: clean(row[1]) || slug, state: clean(row[2]).toUpperCase() || 'IL', token: clean(row[3]).toLowerCase(),
      upload_folder_id: clean(row[5]), has_tab: Boolean(tab), rows, answers,
    });
  }
  return clients;
}

// ── Sending ───────────────────────────────────────────────────────────────────

export async function runImport(clients, { api, catalogKeys, dryRun = false, statuses = {}, log = console.log }) {
  const known = new Set(catalogKeys);
  const report = [];
  for (const c of clients) {
    const unknown = Object.keys(c.answers).filter(k => !known.has(k));
    const answers = Object.fromEntries(Object.entries(c.answers).filter(([k]) => known.has(k)));
    const status = statuses[c.slug] || 'active';
    const entry = { slug: c.slug, name: c.name, state: c.state, status, answers: Object.keys(answers).length, unknown, created: false, existed: false, written: 0, warnings: [] };
    if (!c.has_tab) entry.warnings.push('no answers tab');
    if (!c.token) entry.warnings.push('no token in the Registry; a new one will be minted and old links will not redirect');
    if (!c.upload_folder_id) entry.warnings.push('no Phase 2 folder id');
    log(`${dryRun ? '[dry-run] ' : ''}${c.slug}: ${c.name} (${c.state}) status=${status} answers=${entry.answers}${unknown.length ? ` skipped=${unknown.length}` : ''}${entry.warnings.length ? ` ⚠ ${entry.warnings.join('; ')}` : ''}`);
    if (unknown.length) log(`    skipped keys not on the form: ${unknown.join(', ')}`);
    if (!dryRun) {
      const body = { slug: c.slug, name: c.name, state: c.state, status, upload_folder_id: c.upload_folder_id, ...(c.token ? { token: c.token } : {}) };
      const created = await api('POST', '/api/clients', body);
      if (created.status === 201) entry.created = true;
      else if (created.status === 409) { entry.existed = true; log(`    already registered; answers will still be written`); }
      else throw new Error(`${c.slug}: create failed ${created.status} ${JSON.stringify(created.data)}`);
      if (entry.answers) {
        const put = await api('PUT', `/api/clients/${encodeURIComponent(c.slug)}/answers`, { answers, by: 'import' });
        if (put.status !== 200) throw new Error(`${c.slug}: answers failed ${put.status} ${JSON.stringify(put.data)}`);
        entry.written = put.data.written;
      }
    }
    report.push(entry);
  }
  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const dryRun = args.includes('--dry-run');
  if (!file) { console.error('usage: node scripts/intake-import.mjs <registry.xlsx> [--dry-run] [--only a,b] [--skip a,b] [--status slug=cancelled,…]'); process.exit(2); }
  const base = (process.env.LOE_API_URL || 'https://loe-generator-production.up.railway.app').replace(/\/+$/, '');
  const key = process.env.MCP_API_KEY || '';
  if (!dryRun && !key) { console.error('MCP_API_KEY is required unless --dry-run'); process.exit(2); }
  const only = opt('--only')?.split(',').map(s => s.trim()).filter(Boolean);
  const skip = new Set((opt('--skip') || '').split(',').map(s => s.trim()).filter(Boolean));
  const statuses = Object.fromEntries((opt('--status') || '').split(',').filter(Boolean).map(p => p.split('=').map(s => s.trim())));

  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };

  const sheets = readWorkbook(readFileSync(file));
  let clients = extractClients(sheets);
  if (only) clients = clients.filter(c => only.includes(c.slug));
  clients = clients.filter(c => !skip.has(c.slug));
  console.log(`${Object.keys(sheets).length} tabs, ${clients.length} client(s) to import${dryRun ? ' (dry run)' : ` into ${base}`}`);

  let catalogKeys;
  if (dryRun && !key) {
    // Without a key the catalog comes from the repo copy, which is the same file the server loads.
    catalogKeys = JSON.parse(readFileSync(new URL('../server/intake-questions.json', import.meta.url), 'utf8')).questions.map(q => q.key);
  } else {
    const q = await api('GET', '/api/intake/questions');
    if (q.status !== 200) { console.error(`could not read the question catalog: ${q.status} ${JSON.stringify(q.data)}`); process.exit(1); }
    catalogKeys = q.data.questions.map(x => x.key);
  }
  const report = await runImport(clients, { api, catalogKeys, dryRun, statuses });
  const created = report.filter(r => r.created).length, existed = report.filter(r => r.existed).length;
  const written = report.reduce((a, r) => a + r.written, 0), skipped = report.reduce((a, r) => a + r.unknown.length, 0);
  console.log(dryRun
    ? `\nDry run: ${report.length} client(s), ${report.reduce((a, r) => a + r.answers, 0) } answer(s) would be written, ${skipped} key(s) skipped.`
    : `\nDone: ${created} created, ${existed} already existed, ${written} answer(s) written, ${skipped} key(s) skipped.`);
}
