// Default letter section text for every document type, plus the pre-call
// notes renderer. The letter wording itself lives in templates/*.json.

import { marked } from "marked";
import PRE_AWARD from "../../templates/pre-award.json";
import IN_HOUSE from "../../templates/in-house.json";
import POST_AWARD from "../../templates/post-award.json";
import ADDENDUM from "../../templates/addendum.json";
import PROPOSAL from "../../templates/proposal.json";

// ─── DEFAULT TEMPLATE SECTIONS ────────────────────────────────────────────────
/*
 * What the app renders before /api/templates answers, and what it keeps
 * rendering if that call fails. They are the server's own files, imported, so
 * the two cannot disagree.
 *
 * They used to be a hand-kept copy in this file, and the post-award copy had
 * fallen a whole contract behind: milestone payments rather than dated ones, no
 * Effective Date, no location list, and no [POST_REIMBURSEMENT_OPTION] — so an
 * Award Implementation letter drafted against the fallback silently lost its
 * reimbursement clause. That mattered more than "only if the server is down":
 * every letter paints from here first, and since #266 an expired login gets a
 * 401 from /api/templates, which fails quietly and leaves the rep drafting the
 * old contract with nothing on screen to say so.
 */
const DEFAULT_PRE = PRE_AWARD.sections;
const DEFAULT_INH = IN_HOUSE.sections;
const DEFAULT_POST = POST_AWARD.sections;
const DEFAULT_ADDENDUM = ADDENDUM;
const DEFAULT_PROPOSAL = PROPOSAL;

// Shared NPSA branding stylesheet injected into both the on-screen preview
// and the Print/PDF window (same string used in both places).
/*
 * The notes are a document, so they read as one in either theme: dark ink on
 * white paper, the way the letter preview does. The rules below were always
 * written for a white page — #182230 headings, #26334d body — and were set
 * onto var(--card), which turns dark navy in dark mode, leaving the rep dark
 * text on a dark card at roughly 1:1. The surface is pinned in App.jsx; .pc
 * carries its own ink so anything these rules don't name (a table, an h4, an
 * <em> outside a paragraph) doesn't inherit the dark theme's light text onto
 * the white page instead.
 */
const PC_NOTES_CSS = `
  .pc{color:#26334d}
  .pc h1{font-size:22px;font-weight:800;color:#182230;margin:0 0 3px;letter-spacing:-0.2px;line-height:1.2}
  .pc h2{font-size:12.5px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:0.7px;margin:22px 0 9px;padding-bottom:6px;border-bottom:2px solid #dce8f4}
  .pc h3{font-size:13px;font-weight:700;color:#182230;margin:14px 0 5px}
  .pc p{margin:0 0 10px;line-height:1.62;color:#26334d;font-size:14px}
  .pc ul{margin:0 0 12px;padding-left:20px}
  .pc li{margin:0 0 4px;line-height:1.55;color:#26334d;font-size:14px}
  .pc ol{margin:0 0 12px;padding-left:20px}
  .pc ol li{margin:0 0 4px;line-height:1.55;color:#26334d;font-size:14px}
  .pc strong{color:#182230;font-weight:700}
  .pc a{color:#1e3a5f;text-decoration:none}
  .pc hr{border:none;border-top:1px solid #e2ecf5;margin:18px 0}
  .pc blockquote{border-left:3px solid #dce8f4;margin:0 0 12px;padding:8px 14px;background:#f7fafd;color:#4a5462;font-size:13px}
`;
function renderPreCallHtml(md){ return `<style>${PC_NOTES_CSS}</style><div class="pc">${marked(String(md||''))}</div>`; }

export {
  DEFAULT_PRE, DEFAULT_INH, DEFAULT_POST, DEFAULT_ADDENDUM, DEFAULT_PROPOSAL,
  PC_NOTES_CSS, renderPreCallHtml,
};
