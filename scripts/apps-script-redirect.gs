/**
 * NSGP Intake Form — redirect stub. Replaces Code.gs on the SAME deployment after the
 * registry has been imported into npsa-tools (docs/grant-clients.md, "Cutover").
 *
 * Every link already in a client's inbox keeps working: doGet looks the slug up in the
 * Registry sheet exactly as before, checks the token, and sends the browser to the
 * same slug and token on the new host. Wrong or unknown links get the same error page
 * they always got. The register / seed / track endpoints answer "moved" so any stale
 * automation fails loudly rather than writing to a sheet nobody reads any more.
 *
 * Deploy: paste over Code.gs, delete Index.html (no longer served), then Deploy →
 * Manage deployments → edit the ACTIVE deployment → Version: New version → Deploy.
 * Editing the existing deployment is what keeps the URL; "New deployment" would not.
 */

const NEW_BASE = 'https://npsa-tools.vercel.app';   // = INTAKE_BASE_URL on Railway
const SHEET_ID = '14nx-G0dZbqn0js0a9Yb3rCD-IV1Fdsf7fHF9kNAG2qk';
const REG_TAB  = 'Registry';

function doGet(e) {
  const p = (e && e.parameter) || {};
  // Gmail-mangled links: ?client%3Dslug%26t%3Dtoken&source=gmail…
  if (!p.client && e && e.queryString) {
    try {
      const raw = decodeURIComponent(e.queryString);
      const m = raw.match(/client=([A-Za-z0-9_-]+)(?:&|%26)t=([A-Za-z0-9]+)/);
      if (m) { p.client = m[1]; p.t = m[2]; }
    } catch (err) { /* fall through to the error page */ }
  }
  const client = String(p.client || '');
  const token  = String(p.t || '');
  const reg = lookupClient_(client);
  if (!reg) return errorPage_('This link isn’t recognized. Please check with Nonprofit Security Advisors.');
  if (!reg.token || reg.token !== token) return errorPage_('This link is invalid or has expired.');

  const url = NEW_BASE + '/client/' + encodeURIComponent(client) + '?t=' + encodeURIComponent(token);
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><base target="_top">' +
    '<title>NSGP — Client Information Collection</title></head><body>' +
    '<div style="font-family:system-ui;max-width:560px;margin:80px auto;text-align:center;color:#15242E">' +
    '<div style="font-size:13px;letter-spacing:.1em;color:#6C7732;font-weight:700;text-transform:uppercase">Nonprofit Security Grant Program</div>' +
    '<h2 style="color:#003C60">Your form has moved</h2>' +
    '<p style="color:#566571">Taking you to it now. Your answers are already there. Bookmark the new address when it opens.</p>' +
    '<p><a href="' + esc_(url) + '" style="display:inline-block;background:#003C60;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open the form</a></p>' +
    '</div><script>try{window.open(' + JSON.stringify(url) + ',"_top");}catch(e){}</script></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('NSGP — Client Information Collection')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  return ContentService.createTextOutput(JSON.stringify({
    error: 'moved',
    message: 'The intake registry now lives in npsa-tools. Use the client_create / intake_seed MCP tools.',
  })).setMimeType(ContentService.MimeType.JSON);
}

function lookupClient_(client) {
  if (!client) return null;
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REG_TAB);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === client) return { client: data[i][0], token: String(data[i][3] || '') };
  }
  return null;
}

function esc_(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function errorPage_(msg) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui;max-width:560px;margin:80px auto;text-align:center;color:#15242E">' +
    '<div style="font-size:13px;letter-spacing:.1em;color:#6C7732;font-weight:700;text-transform:uppercase">Nonprofit Security Grant Program</div>' +
    '<h2 style="color:#003C60">Client Information Collection</h2><p style="color:#566571">' + esc_(msg) + '</p></div>')
    .setTitle('NSGP — Client Information Collection');
}
