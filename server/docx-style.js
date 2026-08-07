/*
 * Makes the pre-call download look like the tool's own document.
 *
 * html-to-docx is handed HTML with its stylesheet stripped, because the library
 * chokes on several of the properties the preview uses — border-bottom,
 * text-transform, fractional line-height. Stripping it works, in that the file
 * opens; the cost is that every heading falls back to the library's defaults,
 * which are 24pt and 18pt plain black Calibri.
 *
 * The target here is not invented. Brad's copy of the City Church notes is the
 * on-screen preview pasted into Word — Arial, ligatures off, a white shading fill
 * on every paragraph, all the fingerprints of a browser paste — and Stuart picked
 * it over a first attempt at branding this from scratch. So the numbers below are
 * read straight out of that file rather than guessed at: his document IS the
 * preview, which is the thing everyone agreed already looked right.
 *
 * Styling it through CSS is the wrong lever anyway: Word does not read a
 * stylesheet, it reads styles.xml. So the CSS stays stripped and the branding is
 * applied afterwards to the part Word actually consults. That also buys the two
 * things inline CSS could not express — small caps headings with letter spacing,
 * and a rule under each section — because those are native Word features even
 * though they are the properties html-to-docx cannot survive.
 */

// Measured from Brad's document. Word counts character size in half-points and
// most spacing in twentieths of a point, hence the doubled numbers.
const INK = '26334D';        // body text
const HEADLINE = '1A2540';   // the title, and bold runs inside body text
const ACCENT = '2C5D8F';     // section headings
const RULE = 'DCE8F4';       // the line under a section heading
const FONT = 'Arial';

const BODY_AFTER = 150;      // space after a normal paragraph
const LIST_AFTER = 60;       // ...and after a bullet, which sits tighter

const FONTS = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="Times New Roman"/>`;

const HEADINGS = {
  Heading1: {
    pPr: '<w:keepNext/><w:keepLines/><w:spacing w:before="0" w:after="45" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="0"/>',
    rPr: `${FONTS}<w:b/><w:bCs/><w:color w:val="${HEADLINE}"/><w:spacing w:val="-3"/><w:kern w:val="36"/><w:sz w:val="33"/><w:szCs w:val="33"/>`,
  },
  Heading2: {
    // caps + character spacing reproduce the preview's uppercase tracked headings;
    // pBdr is the rule underneath. Both are ordinary Word features — they were only
    // ever missing because they had to survive an HTML-to-Word conversion.
    pPr: `<w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="5" w:color="${RULE}"/></w:pBdr>`
       + '<w:spacing w:before="330" w:after="135" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="1"/>',
    rPr: `${FONTS}<w:b/><w:bCs/><w:caps/><w:color w:val="${ACCENT}"/><w:spacing w:val="11"/><w:sz w:val="19"/><w:szCs w:val="19"/>`,
  },
  Heading3: {
    // Brad's document has no h3, but it does have bold sub-labels like "Federal
    // NSGP" — body size, bold, headline colour. An h3 is the same thing, so it is
    // matched to those rather than to a size he never used.
    pPr: '<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="2"/>',
    rPr: `${FONTS}<w:b/><w:bCs/><w:color w:val="${HEADLINE}"/><w:sz w:val="21"/><w:szCs w:val="21"/>`,
  },
};

const DOC_DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr>'
  + FONTS
  + `<w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/>`
  + '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>'
  + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
  + `<w:spacing w:after="${BODY_AFTER}" w:line="240" w:lineRule="auto"/>`
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

/**
 * Applies the branding to a styles.xml produced by html-to-docx.
 *
 * The existing styles are PATCHED rather than replaced. The document body refers
 * to Heading1..6 and Hyperlink by id, and numbering.xml carries its own
 * references; rewriting the file wholesale risks breaking one for no gain.
 */
export function brandStyles(xml) {
  let out = String(xml || '');
  out = out.replace(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/, DOC_DEFAULTS);
  for (const [id, { pPr, rPr }] of Object.entries(HEADINGS)) {
    out = patchStyle(out, id, 'pPr', pPr);
    out = patchStyle(out, id, 'rPr', rPr);
  }
  // Links take the document's accent rather than the browser blue the library
  // hard-codes, which is the single loudest "unstyled" signal in the file.
  out = patchStyle(out, 'Hyperlink', 'rPr', `<w:color w:val="${ACCENT}"/><w:u w:val="single"/>`);
  return out;
}

/**
 * The two things a stylesheet cannot reach, applied to the body instead.
 *
 * Bold runs: Brad's document darkens **bold** text to the headline colour, which a
 * paragraph style cannot do because bold is a run-level property applied by the
 * markdown, not a named style.
 *
 * Paragraph spacing: html-to-docx stamps `<w:spacing w:lineRule="auto"/>` onto
 * every paragraph as DIRECT formatting. Direct formatting outranks a style, so the
 * spacing set in docDefaults would be quietly ignored on every paragraph in the
 * document. Rewriting those stamps is the only way the defaults ever apply, and
 * bullets get the tighter value Brad's list items use.
 *
 * Runs before the schema reorder, so anything inserted here is put in order after.
 */
export function brandDocument(xml) {
  let out = String(xml || '');

  out = out.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (whole, inner) => {
    if (!/<w:b\s*\/>/.test(inner)) return whole;
    if (/<w:color\b/.test(inner)) return whole;   // never override an explicit colour
    return `<w:rPr>${inner}<w:color w:val="${HEADLINE}"/></w:rPr>`;
  });

  out = out.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/g, (whole, inner) => {
    // Headings carry their spacing in the style — but the library's bare stamp is
    // still direct formatting sitting on top of it, so it has to go rather than
    // merely be skipped, or it keeps a say in how the heading is spaced.
    if (/<w:pStyle w:val="Heading/.test(inner)) {
      return `<w:pPr>${inner.replace(/<w:spacing w:lineRule="auto"\/>/g, '')}</w:pPr>`;
    }
    const after = /<w:numPr>/.test(inner) ? LIST_AFTER : BODY_AFTER;
    const spacing = `<w:spacing w:after="${after}" w:line="240" w:lineRule="auto"/>`;
    return `<w:pPr>${/<w:spacing\b[^>]*\/>/.test(inner)
      ? inner.replace(/<w:spacing\b[^>]*\/>/, spacing)
      : inner + spacing}</w:pPr>`;
  });

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

export const __test = {
  patchStyle, HEADINGS, DOC_DEFAULTS, INK, ACCENT, HEADLINE, RULE, FONT,
  BODY_AFTER, LIST_AFTER,
};
