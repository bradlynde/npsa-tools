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
// Fetches a page server-side and returns stripped, length-capped text. Best
// effort — returns null on any failure (timeout, block, bad URL).
async function fetchPage(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NPSA-PreCall/1.0)' } });
    if (!r.ok) return null;
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
      .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
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

app.post('/api/precall', async (req, res) => {
  const { calendlyText } = req.body || {};
  if (!calendlyText || !calendlyText.trim()) {
    return res.status(400).json({ error: 'No Calendly text provided' });
  }
  try {
    const client = getOpenAI();

    // Step 1 — extract the org website (and name) so we can crawl it.
    let websiteUrl = null, orgName = null;
    try {
      const extraction = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `From this Calendly invite, extract the organization name and its website URL if present. Respond ONLY with compact JSON like {"org_name":"...","website_url":"..."}. Use null for anything not found.\n\n${calendlyText.slice(0, 4000)}`
        }],
        response_format: { type: 'json_object' },
      });
      const parsed = JSON.parse(extraction.choices[0]?.message?.content || '{}');
      orgName = parsed.org_name || null;
      websiteUrl = parsed.website_url || null;
    } catch { /* extraction is best-effort */ }

    // Step 2 — crawl the org site (homepage + common subpages) server-side.
    let siteText = '';
    const base = normalizeBaseUrl(websiteUrl);
    if (base) {
      const pages = await Promise.all([
        fetchPage(base),
        fetchPage(`${base}/about`),
        fetchPage(`${base}/contact`),
        fetchPage(`${base}/locations`),
        fetchPage(`${base}/campuses`),
      ]);
      siteText = pages.filter(Boolean).join('\n\n').slice(0, 15000);
    }

    // Step 3 — generate the notes with GPT-4o.
    const context = [
      `CALENDLY INVITE:\n${calendlyText}`,
      base ? `\n\nORGANIZATION WEBSITE (${base}):` : `\n\nORGANIZATION WEBSITE: not provided / not found — mark website-dependent fields as TBD.`,
      siteText ? `\nSCRAPED WEBSITE TEXT (use to verify titles & addresses; do not invent):\n${siteText}` : (base ? '\nWebsite could not be fetched — mark website-dependent fields as TBD.' : ''),
    ].join('');

    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2200,
      messages: [
        { role: 'system', content: PRECALL_MASTER_PROMPT },
        { role: 'user', content: context },
      ],
    });
    res.json({
      notes: completion.choices[0]?.message?.content || '',
      website: base || null,
      websiteFetched: !!siteText,
      orgName,
    });
  } catch (err) {
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
