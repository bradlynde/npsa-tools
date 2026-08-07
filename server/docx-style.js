/*
 * Makes the pre-call download look like the tool's own document.
 *
 * html-to-docx is handed HTML with its stylesheet stripped, because the library
 * chokes on several of the properties the preview uses — border-bottom,
 * text-transform, fractional line-height. Stripping it works, in that the file
 * opens; the cost is that every heading falls back to the library's defaults,
 * which are 24pt and 18pt plain black Calibri. Stuart's verdict on the result was
 * that it "looks like it's for a grandma", and the preview looking right while the
 * download looks like that is the whole complaint.
 *
 * Styling it through CSS is the wrong lever anyway: Word does not read a
 * stylesheet, it reads styles.xml. So the CSS stays stripped, and the branding is
 * applied afterwards to the part Word actually consults. That also buys the two
 * things inline CSS could not express — small caps headings with letter spacing,
 * and a rule under each section — because those are native Word style features
 * even though they are the properties html-to-docx cannot survive.
 *
 * The existing styles are PATCHED rather than replaced. The document body refers
 * to Heading1..6 and Hyperlink by id, and numbering.xml carries its own
 * references; rewriting the file wholesale risks breaking a reference for no gain.
 */

// Matches the on-screen preview (PC_NOTES_CSS in src/generator/templates.js).
// Word measures character size in half-points and most spacing in twentieths of a
// point, hence the doubled numbers.
const INK = '26334D';        // body text
const HEADLINE = '182230';   // h1 / bold
const ACCENT = '1E3A5F';     // section headings and links
const RULE = 'DCE8F4';       // the line under a section heading

const HEADINGS = {
  Heading1: {
    pPr: '<w:keepNext/><w:keepLines/><w:spacing w:before="0" w:after="60"/><w:outlineLvl w:val="0"/>',
    rPr: `<w:b/><w:color w:val="${HEADLINE}"/><w:sz w:val="34"/><w:szCs w:val="34"/>`,
  },
  Heading2: {
    // caps + character spacing reproduce the preview's uppercase tracked headings;
    // pBdr is the rule underneath. Both are ordinary Word features — they were only
    // ever missing because they had to survive an HTML-to-Word conversion.
    pPr: `<w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="3" w:color="${RULE}"/></w:pBdr>`
       + '<w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/>',
    rPr: `<w:b/><w:caps/><w:color w:val="${ACCENT}"/><w:spacing w:val="12"/><w:sz w:val="20"/><w:szCs w:val="20"/>`,
  },
  Heading3: {
    pPr: '<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/>',
    rPr: `<w:b/><w:color w:val="${HEADLINE}"/><w:sz w:val="22"/><w:szCs w:val="22"/>`,
  },
};

const DOC_DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsiaTheme="minorHAnsi" w:cstheme="minorBidi"/>'
  + `<w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/>`
  + '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>'
  + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
  + '<w:spacing w:after="100" w:line="264" w:lineRule="auto"/>'
  + '</w:pPr></w:pPrDefault></w:docDefaults>';

/** Swaps the first child block of a named style, leaving everything else alone. */
function patchStyle(xml, styleId, tag, inner) {
  const styleRe = new RegExp(`(<w:style [^>]*w:styleId="${styleId}"[^>]*>)([\\s\\S]*?)(</w:style>)`);
  return xml.replace(styleRe, (_whole, open, body, close) => {
    const blockRe = new RegExp(`<w:${tag}>[\\s\\S]*?</w:${tag}>`);
    const block = `<w:${tag}>${inner}</w:${tag}>`;
    // A style that never declared the block still needs it added, or the patch is
    // a silent no-op — which is how "styled" output ends up looking untouched.
    return open + (blockRe.test(body) ? body.replace(blockRe, block) : body + block) + close;
  });
}

/** Applies NPSA branding to a styles.xml produced by html-to-docx. */
export function brandStyles(xml) {
  let out = String(xml || '');
  out = out.replace(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/, DOC_DEFAULTS);
  for (const [id, { pPr, rPr }] of Object.entries(HEADINGS)) {
    out = patchStyle(out, id, 'pPr', pPr);
    out = patchStyle(out, id, 'rPr', rPr);
  }
  // Links inherit the document's accent rather than the browser blue the library
  // hard-codes, which is the single loudest "unstyled" signal in the file.
  out = patchStyle(out, 'Hyperlink', 'rPr', `<w:color w:val="${ACCENT}"/><w:u w:val="single"/>`);
  return out;
}

/**
 * Keeps the space between two inline elements.
 *
 * html-to-docx discards a whitespace-only text node when the next sibling is an
 * inline element, but keeps it when the next sibling is plain text. So
 * `<strong>Church Website:</strong> <a>https://olph1.org</a>` came out as
 * "Church Website:https://olph1.org", while the phone number on the line below —
 * plain text, no link — kept its space. A non-breaking space is a text node with
 * content, so it survives.
 */
export function preserveInlineSpacing(html) {
  const INLINE = 'a|strong|em|b|i|code|span|u';
  return String(html || '').replace(
    new RegExp(`(</(?:${INLINE})>)[ \\t]+(<(?:${INLINE})[\\s>])`, 'gi'),
    '$1&nbsp;$2',
  );
}

export const __test = { patchStyle, HEADINGS, DOC_DEFAULTS, INK, ACCENT, HEADLINE, RULE };
