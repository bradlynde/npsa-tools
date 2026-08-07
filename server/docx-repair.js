/*
 * Makes html-to-docx output openable in Word.
 *
 * html-to-docx@1.8.0 emits paragraph properties in source order, so a paragraph
 * that has indentation, alignment and spacing comes out as
 *
 *     <w:pPr><w:ind/><w:jc/><w:spacing/></w:pPr>
 *
 * OOXML (ECMA-376 §17.3.1.26) fixes the order of w:pPr's children, and spacing
 * comes before ind, which comes before jc. Word validates against the schema and
 * refuses the whole file when the order is wrong — "Word found unreadable
 * content" — even though the XML is well formed, the zip is valid and every
 * relationship resolves. That is why the file opens fine in Google Docs, Pages
 * and LibreOffice, all of which are lenient, and only Word rejects it.
 *
 * Rather than fork the library, reorder the children after generation. The same
 * rule applies to w:rPr (§17.3.2.27), which is correct today but cheap to guard.
 */

import JSZip from "jszip";
import { brandStyles, brandDocument } from "./docx-style.js";

// Schema order of w:pPr children (ECMA-376 §17.3.1.26).
const PPR_ORDER = [
  "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
  "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
  "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
  "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind",
  "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
  "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
  "sectPr", "pPrChange",
];

// Schema order of w:rPr children (ECMA-376 §17.3.2.27).
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
  "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid",
  "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz",
  "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign",
  "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
];

/**
 * Split a properties block into top-level child elements. Handles both
 * self-closing (<w:jc w:val="left"/>) and paired (<w:rPr>…</w:rPr>) children,
 * so nesting inside numPr or rPr is preserved intact.
 */
function splitChildren(inner) {
  const out = [];
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<", i);
    if (lt === -1) break;
    const nameMatch = /^<(w:[\w]+)/.exec(inner.slice(lt));
    if (!nameMatch) { i = lt + 1; continue; }
    const name = nameMatch[1];
    const gt = inner.indexOf(">", lt);
    if (gt === -1) break;

    if (inner[gt - 1] === "/") {           // self-closing
      out.push({ name, xml: inner.slice(lt, gt + 1) });
      i = gt + 1;
      continue;
    }
    // paired — find its matching close, allowing same-named nesting
    let depth = 1, cursor = gt + 1;
    const open = new RegExp(`<${name}[\\s>]`, "g");
    const close = new RegExp(`</${name}>`, "g");
    while (depth > 0 && cursor < inner.length) {
      open.lastIndex = cursor; close.lastIndex = cursor;
      const o = open.exec(inner); const c = close.exec(inner);
      if (!c) break;
      if (o && o.index < c.index) { depth++; cursor = o.index + 1; }
      else { depth--; cursor = c.index + c[0].length; }
    }
    out.push({ name, xml: inner.slice(lt, cursor) });
    i = cursor;
  }
  return out;
}

function reorderBlocks(xml, tag, order) {
  const rank = new Map(order.map((n, i) => [`w:${n}`, i]));
  return xml.replace(new RegExp(`<w:${tag}>([\\s\\S]*?)</w:${tag}>`, "g"), (whole, inner) => {
    const kids = splitChildren(inner);
    if (kids.length < 2) return whole;
    // Unknown elements keep their position relative to the end rather than
    // being dropped — reordering must never lose content.
    const sorted = kids
      .map((k, i) => ({ ...k, i, r: rank.has(k.name) ? rank.get(k.name) : order.length + i }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i));
    if (sorted.every((k, i) => k.i === i)) return whole;   // already in order
    return `<w:${tag}>${sorted.map((k) => k.xml).join("")}</w:${tag}>`;
  });
}

/**
 * Reorder property children in a .docx buffer so Word will open it.
 *
 * With `brand`, also restyles styles.xml — see server/docx-style.js. Both jobs
 * edit parts of the same zip, so they share one open/close rather than each
 * unpacking and repacking the file.
 */
export async function repairDocx(buffer, { brand = false } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const target = "word/document.xml";
  const file = zip.file(target);
  if (!file) return buffer;

  let xml = await file.async("string");
  // Branding runs FIRST so that whatever it inserts is then put into schema order
  // by the pass below. A colour added after the reorder would be the very thing
  // that stops Word opening the file.
  if (brand) xml = brandDocument(xml);
  xml = reorderBlocks(xml, "pPr", PPR_ORDER);
  xml = reorderBlocks(xml, "rPr", RPR_ORDER);
  zip.file(target, xml);

  if (brand) {
    const styles = zip.file("word/styles.xml");
    // Branding is cosmetic; a document that opens unstyled beats one that fails.
    if (styles) zip.file("word/styles.xml", brandStyles(await styles.async("string")));
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export const __test = { reorderBlocks, splitChildren, PPR_ORDER, RPR_ORDER };
