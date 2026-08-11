/*
 * Makes html-to-docx output openable in Word.
 *
 * html-to-docx@1.8.0 emits property children in source order. OOXML fixes that
 * order, and Word validates against the schema and refuses the whole file when it
 * is wrong — "Word experienced an error trying to open the file" — even though
 * the XML is well formed, the zip is valid and every relationship resolves. Google
 * Docs, Pages and LibreOffice are all lenient and open the same file happily,
 * which is exactly why this keeps looking like a problem with one person's Word.
 *
 * The first pass at this covered w:pPr and w:rPr, which is what an ordinary
 * paragraph needs. It was not enough. Anything the library emits with a fixed
 * child sequence has the same defect, and TABLES have five more of them — so a
 * briefing containing a table still failed to open while one without it was fine.
 * That is what made the failure look intermittent.
 *
 * Rather than fork the library, reorder after generation, for every container
 * whose sequence the schema fixes.
 *
 * The other way Word refuses a file is that it is not well-formed XML at all.
 * Control characters are illegal in XML 1.0 and html-to-docx passes them straight
 * through. U+000B is the character Word itself writes for a line break inside a
 * paragraph, so pasting from Word into the notes editor is enough to produce a
 * file Word will not reopen. See stripXmlIllegal below.
 */

import JSZip from "jszip";
import { brandStyles, brandDocument } from "./docx-style.js";

/*
 * Schema child sequences (ECMA-376 Part 1). Only the containers html-to-docx
 * actually emits are listed; adding one that never appears costs a regex pass
 * over the document for nothing.
 *
 * `left`/`right` and `start`/`end` are the same slot in two naming generations,
 * so they share a rank rather than being treated as distinct elements.
 */
const ORDERS = {
  // §17.3.1.26
  pPr: ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
    "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
    "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
    "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind",
    "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
    "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
    "sectPr", "pPrChange"],
  // §17.3.2.27
  rPr: ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid",
    "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz",
    "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign",
    "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"],
  // §17.4.60 — the library emits jc LAST here, which is the table killer.
  tblPr: ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
    "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd", "tblBorders",
    "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption", "tblDescription",
    "tblPrChange"],
  // §17.4.81
  trPr: ["cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter",
    "cantSplit", "trHeight", "tblHeader", "tblCellSpacing", "jc", "hidden", "ins",
    "del", "trPrChange"],
  // §17.4.70
  tcPr: ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd",
    "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark",
    "headers", "cellIns", "cellDel", "cellMerge", "tcPrChange"],
  // §17.4.39 / §17.4.67 — emitted as top,bottom,left,right; left belongs second.
  tblBorders: ["top", "start", "left", "bottom", "end", "right", "insideH", "insideV"],
  tcBorders: ["top", "start", "left", "bottom", "end", "right", "insideH", "insideV",
    "tl2br", "tr2bl"],
  // §17.4.43 / §17.4.42
  tblCellMar: ["top", "start", "left", "bottom", "end", "right"],
  tcMar: ["top", "start", "left", "bottom", "end", "right"],
  // §17.3.1.24
  pBdr: ["top", "left", "bottom", "right", "between", "bar"],
  // §17.9.19
  numPr: ["ilvl", "numId", "numberingChange", "ins"],
  // §17.6.18
  sectPr: ["footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders",
    "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote", "titlePg",
    "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange"],
};

// left/start and right/end name the same slot; give them one rank so a document
// mixing the two generations is not reordered into nonsense.
const ALIAS = { left: "start", right: "end" };

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
  const rank = new Map();
  order.forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });
  const rankOf = (name) => {
    const bare = name.slice(2);                     // strip the w: prefix
    const r = rank.get(bare);
    return r !== undefined ? r : rank.get(ALIAS[bare]);
  };
  return xml.replace(new RegExp(`<w:${tag}>([\\s\\S]*?)</w:${tag}>`, "g"), (whole, inner) => {
    const kids = splitChildren(inner);
    if (kids.length < 2) return whole;
    // Unknown elements keep their position relative to the end rather than
    // being dropped — reordering must never lose content.
    const sorted = kids
      .map((k, i) => {
        const r = rankOf(k.name);
        return { ...k, i, r: r !== undefined ? r : order.length + i };
      })
      .sort((a, b) => (a.r - b.r) || (a.i - b.i));
    if (sorted.every((k, i) => k.i === i)) return whole;   // already in order
    return `<w:${tag}>${sorted.map((k) => k.xml).join("")}</w:${tag}>`;
  });
}

/**
 * Remove characters that are illegal in XML 1.0.
 *
 * This is a different failure from the ordering one and produces the same dialog.
 * A file containing a raw U+000B is not schema-invalid, it is not well-formed at
 * all, so Word rejects it before it gets as far as validating anything.
 *
 * These arrive from real content rather than from anything exotic: Word stores a
 * shift-return as U+000B, so text pasted out of Word — a mission statement, a
 * paragraph from a PDF — carries them, and the notes editor passes them through
 * to the export untouched.
 *
 * Tab, newline and carriage return are the three control characters XML allows and
 * are kept. The rest become a space rather than vanishing, so words either side of
 * one do not get welded together.
 */
export function stripXmlIllegal(s) {
  return String(s)
    // C0 controls except \t \n \r, then DEL + the C1 range, then the two
    // permanently-unassigned noncharacters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, ' ')
    // Unpaired surrogates are illegal too, and survive a round trip through a
    // scraped page often enough to be worth handling rather than hoping.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ' ')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ' ');
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
  const file = zip.file("word/document.xml");
  if (!file) return buffer;

  let xml = await file.async("string");
  // Branding runs FIRST so that whatever it inserts is then put into schema order
  // by the pass below. A colour added after the reorder would be the very thing
  // that stops Word opening the file.
  if (brand) xml = brandDocument(xml);
  zip.file("word/document.xml", tidy(xml));

  if (brand) {
    const styles = zip.file("word/styles.xml");
    // Branding is cosmetic; a document that opens unstyled beats one that fails.
    if (styles) zip.file("word/styles.xml", brandStyles(await styles.async("string")));
  }

  /*
   * Every other XML part gets the same treatment, for two reasons. styles.xml is
   * rewritten by the branding pass just above and carries a w:pBdr of its own, and
   * docProps/core.xml carries the title — which is the filename, which is the
   * organisation name, which is user input. A control character in a church's name
   * would otherwise break the file from a part nobody thinks to look at.
   */
  for (const name of Object.keys(zip.files)) {
    if (name === "word/document.xml" || zip.files[name].dir || !name.endsWith(".xml")) continue;
    zip.file(name, tidy(await zip.file(name).async("string")));
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Both repairs, in the order they have to happen. */
function tidy(xml) {
  let out = stripXmlIllegal(xml);
  for (const [tag, order] of Object.entries(ORDERS)) out = reorderBlocks(out, tag, order);
  return out;
}

export const __test = { reorderBlocks, splitChildren, stripXmlIllegal, tidy, ORDERS, ALIAS };
