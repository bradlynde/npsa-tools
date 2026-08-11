#!/usr/bin/env node
/*
 * Word-export check for the pre-call briefing.
 *
 * Two separate complaints live here. The first is that the file would not open at
 * all: html-to-docx writes paragraph properties in source order and OOXML fixes
 * that order, so Word rejected the whole document while every lenient reader
 * opened it fine. The second is that once it did open it "looks like it's for a
 * grandma" — the stylesheet has to be stripped before conversion, which left every
 * heading on the library's 24pt plain black defaults.
 *
 * So this asserts both: that the schema ordering is clean, and that the branding
 * actually reached styles.xml. It also pins the whitespace bug that turned
 * "Church Website: https://olph1.org" into "Church Website:https://olph1.org" —
 * html-to-docx drops a whitespace-only node before an inline element but keeps it
 * before plain text, which is why only the linked lines lost their space.
 *
 *   node scripts/precall-docx.mjs
 */

import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';
import JSZip from 'jszip';
import { repairDocx, __test as repairTest } from '../server/docx-repair.js';
import { preserveInlineSpacing } from '../server/docx-style.js';

const MD = `# Our Lady of Perpetual Help — CA
**Monday, August 10, 2026 · 9:30 AM CDT** · NPSA 30-Minute Introduction Call

## Meeting Details
- **Church Website:** https://olph1.org
- **Contact Phone:** +1 661-327-7741

### A sub-heading
Body copy that should inherit the document's ink colour rather than pure black.
`;

const html = `<html><head><meta charset="utf-8"><style>h2{border-bottom:2px solid #000}</style></head><body>${marked(MD)}</body></html>`;
// Mirrors /api/precall/docx exactly.
const safeHtml = preserveInlineSpacing(html.replace(/<style[\s\S]*?<\/style>/gi, ''));
const generated = await HTMLtoDOCX(safeHtml, null, {
  title: 'Pre-Call Notes',
  margins: { top: 720, right: 1080, bottom: 720, left: 1080 },
  font: 'Calibri', fontSize: 22, lineHeight: 276,
});
const buffer = await repairDocx(generated, { brand: true });

const zip = await JSZip.loadAsync(buffer);
const doc = await zip.file('word/document.xml').async('string');
const styles = await zip.file('word/styles.xml').async('string');

// Nothing may be lost to either transform.
const before = (await (await JSZip.loadAsync(generated)).file('word/document.xml').async('string'))
  .match(/<w:t[^>]*>/g)?.length ?? 0;
const after = doc.match(/<w:t[^>]*>/g)?.length ?? 0;

/*
 * Count property blocks still out of schema order — the thing Word rejects.
 *
 * This is deliberately written against repairDocx's own ORDERS table rather than
 * a copy: the point is to prove the repair ran over everything it knows about, and
 * a second hand-maintained list would drift. Coverage of the list itself is
 * asserted separately, by generating a document containing a table.
 */
const outOfOrder = (xml, tag) => {
  const order = repairTest.ORDERS[tag];
  const rank = new Map();
  order.forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });
  const rankOf = (n) => {
    const bare = n.slice(2);
    return rank.has(bare) ? rank.get(bare) : rank.get(repairTest.ALIAS[bare]);
  };
  let bad = 0;
  for (const [, inner] of xml.matchAll(new RegExp(`<w:${tag}>([\\s\\S]*?)</w:${tag}>`, 'g'))) {
    const ranks = repairTest.splitChildren(inner).map((k) => rankOf(k.name)).filter((r) => r != null);
    if (ranks.some((r, i) => i && r < ranks[i - 1])) bad++;
  }
  return bad;
};

/** Every container in the whole part, so a new one cannot be quietly missed. */
const anyOutOfOrder = (xml) =>
  Object.keys(repairTest.ORDERS).reduce((n, tag) => n + outOfOrder(xml, tag), 0);

// XML 1.0's legal character set. A file breaking this is not schema-invalid, it is
// not parseable, and Word gives the same unhelpful dialog for both.
const illegalChars = (xml) => [...xml].filter((c) => {
  const p = c.codePointAt(0);
  return !(p === 9 || p === 10 || p === 13 || (p >= 0x20 && p <= 0xD7FF)
        || (p >= 0xE000 && p <= 0xFFFD) || (p >= 0x10000 && p <= 0x10FFFF));
}).length;

/*
 * A second document, carrying the two things that still broke Word after the first
 * repair shipped: a table, and text pasted out of Word.
 *
 * U+000B is not a hypothetical. It is what Word stores for a shift-return, so it
 * rides along on any paragraph a rep copies out of a Word document and pastes into
 * the notes editor — and it made the export unopenable in the application it came
 * from.
 */
const HOSTILE_MD = `# Plainfield Christian Church — IN

## Funding Snapshot

| Track | Cap |
| --- | --- |
| Federal NSGP | $200,000 per site |
| Indiana | no state program |

## Organization Overview
Pasted from Word: a mission statement across three lines.
Scraped from the site: attendance  1,400.
`;
const hostileHtml = `<html><head><meta charset="utf-8"></head><body>${marked(HOSTILE_MD)}</body></html>`;
const hostile = await repairDocx(
  await HTMLtoDOCX(preserveInlineSpacing(hostileHtml), null, {
    title: 'Pre-Call Notes', margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    font: 'Arial', fontSize: 21, lineHeight: 240,
  }), { brand: true });
const hostileZip = await JSZip.loadAsync(hostile);
const hostileDoc = await hostileZip.file('word/document.xml').async('string');
const hostileParts = await Promise.all(
  Object.keys(hostileZip.files)
    .filter((n) => n.endsWith('.xml') && !hostileZip.files[n].dir)
    .map(async (n) => [n, await hostileZip.file(n).async('string')]));

const styleHas = (id, needle) => {
  const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles);
  return !!m && m[0].includes(needle);
};

// Every value below is read out of Brad's marked-up City Church document, which
// Stuart picked over a first attempt at branding this from scratch. They are
// asserted as exact numbers rather than "is it styled at all", because matching
// that file is the requirement — a near miss is the thing being fixed.
const checks = {
  'pPr blocks in schema order': outOfOrder(doc, 'pPr') === 0,
  'rPr blocks in schema order': outOfOrder(doc, 'rPr') === 0,
  'no text runs lost': before === after && after > 0,

  // ── the second round of "Word won't open it" ──────────────────────────────
  // A briefing with a table failed while one without it opened, which is what
  // made this look like a problem with one person's machine.
  'a document with a table has every container in schema order':
    anyOutOfOrder(hostileDoc) === 0,
  'the table really is there to be checked': /<w:tbl>/.test(hostileDoc),
  'table properties specifically are ordered':
    outOfOrder(hostileDoc, 'tblPr') === 0 && outOfOrder(hostileDoc, 'tcBorders') === 0
    && outOfOrder(hostileDoc, 'tblBorders') === 0 && outOfOrder(hostileDoc, 'tblCellMar') === 0,

  /*
   * The one that broke every export, and that four rounds of reasoning missed.
   *
   * CT_Body is a sequence: block-level content, then an optional sectPr LAST.
   * html-to-docx writes sectPr FIRST, which makes every paragraph and table after
   * it invalid — 22 schema errors in a short briefing, all downstream of a single
   * misplaced element. No table and no unusual characters needed; it is in every
   * file the library produces, which is why swapping content never changed the
   * outcome.
   *
   * These assertions were not derived by reading the spec and guessing. They come
   * from validating the output against the real OOXML schema with Apache POI's
   * XMLBeans type system, after a file built by a different tool opened where ours
   * did not. `node scripts/precall-docx-schema.mjs` re-runs that validation.
   */
  'sectPr is the last thing in the body': (() => {
    const body = /<w:body>([\s\S]*)<\/w:body>/.exec(hostileDoc)?.[1] ?? '';
    const kids = repairTest.splitChildren(body);
    return kids.length > 1 && kids[kids.length - 1].name === 'w:sectPr'
      && kids.filter((k) => k.name === 'w:sectPr').length === 1;
  })(),
  'no attribute is the literal string "undefined"':
    hostileParts.every(([, xml]) => !/="undefined"/.test(xml)),
  'page margins are all real measurements':
    /<w:pgMar\b[^>]*>/.test(hostileDoc)
    && !/<w:pgMar\b[^>]*(?:undefined|NaN|null)/.test(hostileDoc),

  /*
   * Cardinality, which the ordering checks are structurally blind to.
   *
   * html-to-docx writes w:tblGrid TWICE per table. §17.4.49 allows exactly one, so
   * a three-column table declared six columns and Word refused the document. The
   * reorder passes sort a container's children and are perfectly happy to sort two
   * of something, so no amount of ordering work was ever going to find this — it
   * took diffing our output against a file built by a different tool that opened.
   */
  'exactly one tblGrid per table': [...hostileDoc.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)]
    .every((m) => (m[0].match(/<w:tblGrid>/g) || []).length === 1),
  'the grid declares as many columns as the rows have cells':
    [...hostileDoc.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].every((m) => {
      const cols = (m[0].match(/<w:gridCol\b/g) || []).length;
      return [...m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)]
        .every((r) => (r[0].match(/<w:tc>/g) || []).length === cols);
    }),

  // ── packaging, which no XML check can see ────────────────────────────────
  // OPC puts the content-types stream first (Part 2 §10.1.2) and Word-produced
  // files carry no directory entries. python-docx reads either happily, so this
  // only showed up against a package built by a different tool.
  'content types stream is the first part':
    Object.keys(hostileZip.files).filter((n) => !hostileZip.files[n].dir)[0] === '[Content_Types].xml',
  'no directory entries in the archive':
    !Object.keys(hostileZip.files).some((n) => hostileZip.files[n].dir),
  'core property dates carry no fractional seconds':
    !/<dcterms:(created|modified)[^>]*>[^<]*\.\d+/.test(
      hostileParts.find(([n]) => n === 'docProps/core.xml')?.[1] || ''),

  // Not schema-invalid — not parseable at all. Same dialog, different cause.
  'no XML-illegal characters survive into any part':
    hostileParts.every(([, xml]) => illegalChars(xml) === 0),
  'the control characters were replaced, not deleted with their neighbours':
    /attendance\s+1,400/.test(hostileDoc.replace(/<[^>]+>/g, '')),
  'stripping leaves ordinary text alone':
    repairTest.stripXmlIllegal('Tab\tnewline\nreturn\r ok') === 'Tab\tnewline\nreturn\r ok',
  'every part is swept, not just document.xml':
    hostileParts.length > 1 && hostileParts.some(([n]) => n === 'docProps/core.xml'),

  'body is Arial': /w:ascii="Arial"/.test(styles),
  'body ink 26334D at 10.5pt':
    /<w:color w:val="26334D"\/>/.test(styles) && /<w:sz w:val="21"\/>/.test(styles),

  'h1 colour 1A2540': styleHas('Heading1', 'w:color w:val="1A2540"'),
  'h1 size 33 half-points': styleHas('Heading1', 'w:sz w:val="33"'),
  'h1 tracking -3 and kern 36':
    styleHas('Heading1', 'w:spacing w:val="-3"') && styleHas('Heading1', 'w:kern w:val="36"'),

  'h2 colour 2C5D8F': styleHas('Heading2', 'w:color w:val="2C5D8F"'),
  'h2 size 19 half-points': styleHas('Heading2', 'w:sz w:val="19"'),
  'h2 small caps and tracking 11':
    styleHas('Heading2', '<w:caps/>') && styleHas('Heading2', 'w:spacing w:val="11"'),
  'h2 rule sz12 space5 DCE8F4':
    styleHas('Heading2', '<w:bottom w:val="single" w:sz="12" w:space="5" w:color="DCE8F4"/>'),
  'h2 spacing before 330 after 135':
    styleHas('Heading2', 'w:before="330"') && styleHas('Heading2', 'w:after="135"'),

  'h3 matches his bold sub-labels':
    styleHas('Heading3', 'w:color w:val="1A2540"') && styleHas('Heading3', 'w:sz w:val="21"'),
  'links are not browser blue':
    styleHas('Hyperlink', 'w:color w:val="2C5D8F"') && !styleHas('Hyperlink', '0000FF'),

  // Direct formatting outranks a style, so these have to reach the body itself.
  'bold runs darkened to 1A2540': /<w:b\/>[\s\S]{0,120}?<w:color w:val="1A2540"\/>/.test(doc),
  'body paragraphs spaced after 150': doc.includes('<w:spacing w:after="150" w:line="240" w:lineRule="auto"/>'),
  'bullets spaced tighter, after 60': doc.includes('<w:spacing w:after="60" w:line="240" w:lineRule="auto"/>'),
  'no lineRule-only stamp left to override the defaults':
    !doc.includes('<w:spacing w:lineRule="auto"/>'),

  // The space that vanished only on lines ending in a link.
  'space kept before a link': /<w:t[^>]*> <\/w:t>/.test(doc),
  'unbranded call leaves styles alone':
    !(await (await JSZip.loadAsync(await repairDocx(generated)))
      .file('word/styles.xml').async('string')).includes('26334D'),
};

let failed = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) failed++;
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
}
console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} checks passed`);
process.exit(failed ? 1 : 0);
