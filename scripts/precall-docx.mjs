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

// Count property blocks still out of schema order — the thing Word rejects.
const outOfOrder = (xml, tag, order) => {
  const rank = new Map(order.map((n, i) => [`w:${n}`, i]));
  let bad = 0;
  for (const [, inner] of xml.matchAll(new RegExp(`<w:${tag}>([\\s\\S]*?)</w:${tag}>`, 'g'))) {
    const ranks = repairTest.splitChildren(inner).map((k) => rank.get(k.name)).filter((r) => r != null);
    if (ranks.some((r, i) => i && r < ranks[i - 1])) bad++;
  }
  return bad;
};

const styleHas = (id, needle) => {
  const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles);
  return !!m && m[0].includes(needle);
};

// Every value below is read out of Brad's marked-up City Church document, which
// Stuart picked over a first attempt at branding this from scratch. They are
// asserted as exact numbers rather than "is it styled at all", because matching
// that file is the requirement — a near miss is the thing being fixed.
const checks = {
  'pPr blocks in schema order': outOfOrder(doc, 'pPr', repairTest.PPR_ORDER) === 0,
  'rPr blocks in schema order': outOfOrder(doc, 'rPr', repairTest.RPR_ORDER) === 0,
  'no text runs lost': before === after && after > 0,

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
