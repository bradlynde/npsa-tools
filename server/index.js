import express from 'express';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

let openai = null;
function getOpenAI() {
  if (!openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not configured');
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS letters (
      id          SERIAL PRIMARY KEY,
      client_name TEXT    NOT NULL DEFAULT 'Untitled',
      rep_name    TEXT    NOT NULL DEFAULT 'Unknown',
      doc_tab     TEXT    NOT NULL DEFAULT 'pre',
      form_data   JSONB   NOT NULL,
      saved_html  TEXT,
      total_fee   NUMERIC DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reps (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    ALTER TABLE letters ADD COLUMN IF NOT EXISTS total_fee NUMERIC DEFAULT 0;
  `).catch(err => console.error('DB init error:', err.message));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dist')));

// AI clause polishing endpoint
app.post('/api/polish', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a legal contract drafting assistant for Nonprofit Security Advisors. Rewrite the following rough clause into polished, professional legal contract language. Return ONLY the polished clause text.\n\nRough clause: ${text}`
      }]
    });
    res.json({ result: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'AI service error' });
  }
});

// ── Pre-Call Notes endpoint ───────────────────────────────────────────────────
// Fetches a page via Jina AI Reader (handles JS-rendered sites, returns clean text).
// Best effort — returns null on any failure (timeout, block, bad URL).
async function fetchViaJina(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      signal: ctrl.signal,
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-No-Cache': 'true' }
    });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 8000);
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function searchForOrgWebsite(orgName, orgType, orgState, ms = 12000) {
  const q = encodeURIComponent(`${orgName}${orgState ? ' ' + orgState : ''} ${orgType || ''} official website`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`https://s.jina.ai/${q}`, {
      signal: ctrl.signal,
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' }
    });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 3000);
  } catch { return null; }
  finally { clearTimeout(t); }
}

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.origin;
  } catch {
    return null;
  }
}

const PRECALL_MASTER_PROMPT = `You are preparing pre-call notes for an NPSA (Nonprofit Security Advisors) sales meeting. You will be given the full text of a Calendly invite email that a prospective client filled out, plus (when available) text scraped from the organization's website to help you verify attendee titles and campus addresses.

Produce a polished, structured plain-text pre-call notes document following EXACTLY this layout and these rules.

MUST-FOLLOW RULES:
1. Always display meeting time in CST (America/Chicago). If another timezone is listed, convert it to CST and show only CST.
2. Default Meeting Host is always Brad Lynde unless another name is explicitly specified.
3. Label the organization's website "School Website" for schools, "Church Website" for churches.
4. Split attendees into: Expected {Organization Name} Attendees, Expected NPSA Attendees, Expected Partner Attendees.
5. For organization attendees: include all invitees and guests from Calendly with Full Name, Title, Email, Phone. Use the phone number provided in the Calendly form. Confirm titles using the organization's website first. If a title cannot be verified, write "Title TBD". Expand shortened names only if verified.
6. Verify and list every campus/property/location found on the org's website with complete postal addresses. For schools use "Campus Location(s) (Verified)"; for churches use "Property / Campus Locations (Verified)". If addresses cannot be verified from the provided website text, write "TBD" and do not invent addresses.
7. Keep these sections present but blank (heading only, no filler): Strategic Insights, Top Three Security Wish List Items, Questions to Ask.
8. Include the state abbreviation after the organization name in the "Pre-Call Notes" title line.
9. Include a short Mission & Values section (1-2 sentence paraphrase from the org's site if available; otherwise "TBD").
10. NEVER fabricate addresses, titles, phone numbers, or facts. Anything you cannot verify from the Calendly input or provided website text must be "TBD".

DOCUMENT LAYOUT:
{ORGANIZATION NAME — bold/caps}
{Weekday, Month DD, YYYY – HH:MM AM/PM CST}

Pre-Call Notes: {Organization Name} — {STATE ABBR}

Meeting Details:
- Event Type: NPSA 30-Minute Introduction Zoom Call
- Date & Time (CST): {converted CST time}
- Meeting Host: Brad Lynde
- Purpose: Discussion of federal and state nonprofit security grant opportunities
- Location: Zoom Web Conference
- Link: {Zoom URL or TBD}
- Meeting ID: {ID or TBD}
- Password: {PW or TBD}
- Organization: {Org Name}
- {Church/School} Website: {URL or TBD}
- Contact Phone: {Org main phone or Calendly number or TBD}

Expected {Organization Name} Attendees
{Full Name | Title | Email | Phone for each}

Expected NPSA Attendees
Brad Lynde | Managing Partner, NPSA | brad@lyndeconsulting.com |

Expected Partner Attendees
{Full Name | Title | Organization | Email — or "None"}

Mission & Values:
{1-2 sentence paraphrase or TBD}

Campus Location(s) (Verified) / Property / Campus Locations (Verified):
{Site | Address | Notes for each, or TBD}

Strategic Insights:

Call Notes:
1. Do you expect to expand your facility, remodel, or build within the next few years?
2. Do you have any close affiliations with other churches or Christian schools you feel might benefit from this?

Top Three Security Wish List Items:
1.
2.
3.

Questions to Ask:

Next Steps (Post-Call): Send Follow Up Email to Include:
1. Engagement Letter
2. Brochure Includes Slide Deck Content and References
3. Scheduling Link – If Second Appt. Has Not Been Scheduled

---
Original Calendly Input:
{paste the full Calendly email verbatim}`;

app.post('/api/precall/parse', async (req, res) => {
  const { calendlyText } = req.body || {};
  if (!calendlyText?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const client = getOpenAI();
    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `Extract structured data from this Calendly invite. Return ONLY valid JSON with these exact keys (use null for anything not found). Detect org_type from the org name (church, school, or other). For meeting_date use YYYY-MM-DD. For meeting_time use HH:MM in 24-hour format. For org_state detect from context (2-letter abbreviation). Convert timezone to one of: CST, EST, PST, MST — use CST if Central Time.\n\n{"org_name":null,"org_type":"church","org_state":null,"website_url":null,"meeting_date":null,"meeting_time":null,"meeting_timezone":"CST","zoom_url":null,"zoom_id":null,"zoom_password":null,"attendees":[{"name":null,"email":null,"phone":null}]}\n\nCalendly invite:\n${calendlyText.slice(0, 5000)}`
      }]
    });
    const parsed = JSON.parse(result.choices[0]?.message?.content || '{}');
    res.json(parsed);
  } catch(e) {
    console.error('Parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/precall', async (req, res) => {
  const { formData, calendlyText } = req.body || {};
  if (!formData && !calendlyText?.trim()) {
    return res.status(400).json({ error: 'No input provided' });
  }
  try {
    const client = getOpenAI();

    let orgName, orgType, orgState, websiteUrl, meetingDate, meetingTime, meetingTimezone,
        zoomUrl, zoomId, zoomPassword, attendees, extraNotes;

    if (formData) {
      ({ orgName, orgType, orgState, websiteUrl, meetingDate, meetingTime, meetingTimezone,
         zoomUrl, zoomId, zoomPassword, attendees, extraNotes } = formData);
    } else {
      // Legacy: parse raw Calendly text
      try {
        const ext = await client.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: `Extract from this Calendly invite. JSON: {"org_name":null,"org_type":"church","org_state":null,"website_url":null,"meeting_date":null,"meeting_time":null,"meeting_timezone":"CST","zoom_url":null,"zoom_id":null,"zoom_password":null,"attendees":[{"name":null,"email":null,"phone":null}]}\n\n${calendlyText.slice(0,4000)}` }],
        });
        const p = JSON.parse(ext.choices[0]?.message?.content || '{}');
        orgName = p.org_name; orgType = p.org_type; orgState = p.org_state;
        websiteUrl = p.website_url; meetingDate = p.meeting_date; meetingTime = p.meeting_time;
        meetingTimezone = p.meeting_timezone || 'CST'; zoomUrl = p.zoom_url; zoomId = p.zoom_id;
        zoomPassword = p.zoom_password; attendees = p.attendees;
      } catch { /* best effort */ }
    }

    // Find website via Jina Search if not provided
    let resolvedWebsite = normalizeBaseUrl(websiteUrl);
    if (!resolvedWebsite && orgName) {
      const searchResults = await searchForOrgWebsite(orgName, orgType, orgState);
      if (searchResults) {
        try {
          const urlFind = await client.chat.completions.create({
            model: 'gpt-4o-mini', max_tokens: 100,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: `Find the official website URL for "${orgName}" from these search results. Return JSON: {"url":"https://..."} or {"url":null}\n\n${searchResults}` }]
          });
          const found = JSON.parse(urlFind.choices[0]?.message?.content || '{}');
          resolvedWebsite = normalizeBaseUrl(found.url);
        } catch { /* best effort */ }
      }
    }

    // Fetch site content via Jina Reader across common paths
    let siteText = '';
    if (resolvedWebsite) {
      const paths = ['', '/about', '/about-us', '/staff', '/leadership', '/team', '/our-church', '/locations', '/campuses', '/contact'];
      const pages = await Promise.allSettled(paths.map(p => fetchViaJina(`${resolvedWebsite}${p}`)));
      siteText = pages
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .join('\n\n')
        .slice(0, 20000);
    }

    // Build structured context block
    const attendeeLines = (attendees || [])
      .filter(a => a && a.name)
      .map(a => `  ${a.name} | ${a.email || ''} | ${a.phone || ''}`)
      .join('\n');

    const context = [
      `MEETING INFORMATION:`,
      `Organization: ${orgName || 'Unknown'}`,
      `Type: ${orgType || 'unknown'}`,
      `State: ${orgState || 'unknown'}`,
      `Date: ${meetingDate || 'TBD'}`,
      `Time: ${meetingTime || 'TBD'} ${meetingTimezone || 'CST'}`,
      `Zoom URL: ${zoomUrl || 'TBD'}`,
      `Zoom Meeting ID: ${zoomId || 'TBD'}`,
      `Zoom Password: ${zoomPassword || 'TBD'}`,
      `Website: ${resolvedWebsite || 'not found'}`,
      ``,
      `ATTENDEES:`,
      attendeeLines || '  (none provided)',
      extraNotes ? `\nADDITIONAL CONTEXT FROM REP:\n${extraNotes}` : '',
      ``,
      resolvedWebsite
        ? `WEBSITE CONTENT (${resolvedWebsite}) — use to verify attendee titles, campus addresses, mission statement. Do NOT invent facts not found here:`
        : `WEBSITE CONTENT: unavailable — mark website-dependent fields as TBD`,
      siteText || '(website could not be fetched)',
    ].filter(l => l !== null).join('\n');

    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 3500,
      messages: [
        { role: 'system', content: PRECALL_MASTER_PROMPT },
        { role: 'user', content: context },
      ],
    });

    res.json({
      notes: completion.choices[0]?.message?.content || '',
      website: resolvedWebsite || null,
      websiteFetched: !!siteText,
      orgName: orgName || null,
    });
  } catch(err) {
    console.error('Pre-call error:', err.message);
    res.status(500).json({ error: 'AI service error' });
  }
});

// Template endpoints — serve JSON files so legal language can be updated
// without touching React code. Edit files in /templates/ and redeploy.
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const TEMPLATE_FILES = {
  'pre-award':  'pre-award.json',
  'in-house':   'in-house.json',
  'post-award': 'post-award.json',
  'proposal':   'proposal.json',
  'addendum':   'addendum.json',
};
app.get('/api/templates/:type', (req, res) => {
  const file = TEMPLATE_FILES[req.params.type];
  if (!file) return res.status(404).json({ error: 'Unknown template type' });
  try {
    res.type('json').send(readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
  } catch {
    res.status(500).json({ error: 'Could not load template' });
  }
});

// ── Letter storage endpoints ──────────────────────────────────────────────────

app.get('/api/letters/stats', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    // Proposals and addendums are saved/loadable but excluded from the letter
    // counter and rep leaderboard so the stats stay engagement-letter focused.
    const [totalRes, byRepRes] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(total_fee),0)::numeric AS total_fees FROM letters WHERE doc_tab NOT IN ('proposal','addendum')"),
      pool.query("SELECT rep_name, COUNT(*)::int AS count FROM letters WHERE doc_tab NOT IN ('proposal','addendum') GROUP BY rep_name ORDER BY count DESC"),
    ]);
    res.json({ total: totalRes.rows[0].total, total_fees: Number(totalRes.rows[0].total_fees), by_rep: byRepRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/letters', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const search = req.query.search || '';
    const result = await pool.query(
      `SELECT id, client_name, rep_name, doc_tab, updated_at FROM letters
       WHERE ($1 = '' OR client_name ILIKE '%' || $1 || '%' OR rep_name ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC`,
      [search]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const result = await pool.query('SELECT * FROM letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/letters', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { client_name, rep_name, doc_tab, form_data, saved_html, total_fee } = req.body;
    const result = await pool.query(
      'INSERT INTO letters (client_name, rep_name, doc_tab, form_data, saved_html, total_fee) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [client_name || 'Untitled', rep_name || 'Unknown', doc_tab || 'pre', JSON.stringify(form_data), saved_html || null, Number(total_fee) || 0]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { client_name, rep_name, doc_tab, form_data, saved_html, total_fee } = req.body;
    await pool.query(
      'UPDATE letters SET client_name=$1, rep_name=$2, doc_tab=$3, form_data=$4, saved_html=$5, total_fee=$6, updated_at=NOW() WHERE id=$7',
      [client_name || 'Untitled', rep_name || 'Unknown', doc_tab || 'pre', JSON.stringify(form_data), saved_html || null, Number(total_fee) || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    await pool.query('DELETE FROM letters WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rep management endpoints ──────────────────────────────────────────────────

app.get('/api/reps', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const result = await pool.query('SELECT id, name FROM reps ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reps', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const result = await pool.query(
      'INSERT INTO reps (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name',
      [name.trim()]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Rep already exists' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reps/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    await pool.query('DELETE FROM reps WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LOE Generator server running on port ${PORT}`);
});
