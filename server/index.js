import express from 'express';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import pg from 'pg';
import HTMLtoDOCX from 'html-to-docx';

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

// ── NSGP State Administering Agency (SAA) lookup ─────────────────────────────
const STATE_SAA = {
  AL:'Alabama Law Enforcement Agency (ALEA)',AK:'Alaska Division of Homeland Security & Emergency Management',
  AZ:'Arizona Department of Emergency & Military Affairs (DEMA)',AR:'Arkansas Division of Emergency Management',
  CA:'California Governor\'s Office of Emergency Services (Cal OES)',CO:'Colorado Division of Homeland Security & Emergency Management',
  CT:'Connecticut Division of Emergency Management & Homeland Security (DEMHS)',DE:'Delaware Emergency Management Agency (DEMA)',
  FL:'Florida Division of Emergency Management',GA:'Georgia Emergency Management & Homeland Security Agency (GEMA/HS)',
  HI:'Hawaii Emergency Management Agency (HI-EMA)',ID:'Idaho Office of Emergency Management',
  IL:'Illinois Emergency Management Agency (IEMA)',IN:'Indiana Department of Homeland Security (IDHS)',
  IA:'Iowa Homeland Security & Emergency Management (HSEMD)',KS:'Kansas Division of Emergency Management',
  KY:'Kentucky Emergency Management (KYEM)',LA:'Louisiana Governor\'s Office of Homeland Security & Emergency Preparedness (GOHSEP)',
  ME:'Maine Emergency Management Agency (MEMA)',MD:'Maryland Emergency Management Agency (MEMA)',
  MA:'Massachusetts Emergency Management Agency (MEMA)',MI:'Michigan State Police, Emergency Management & Homeland Security Division',
  MN:'Minnesota Department of Public Safety — Homeland Security & Emergency Management (HSEM)',
  MS:'Mississippi Emergency Management Agency (MEMA)',MO:'Missouri State Emergency Management Agency (SEMA)',
  MT:'Montana Disaster & Emergency Services (DES)',NE:'Nebraska Emergency Management Agency (NEMA)',
  NV:'Nevada Division of Emergency Management (NDEM)',NH:'New Hampshire Division of Homeland Security & Emergency Management (HSEM)',
  NJ:'New Jersey Office of Homeland Security & Preparedness (OHSP)',NM:'New Mexico Department of Homeland Security & Emergency Management',
  NY:'New York Division of Homeland Security & Emergency Services (DHSES)',NC:'North Carolina Emergency Management (NCEM)',
  ND:'North Dakota Department of Emergency Services (DES)',OH:'Ohio Emergency Management Agency (Ohio EMA)',
  OK:'Oklahoma Department of Emergency Management & Homeland Security',OR:'Oregon Office of Emergency Management (OEM)',
  PA:'Pennsylvania Emergency Management Agency (PEMA)',RI:'Rhode Island Emergency Management Agency (RIEMA)',
  SC:'South Carolina Emergency Management Division (SCEMD)',SD:'South Dakota Office of Emergency Management (OEM)',
  TN:'Tennessee Emergency Management Agency (TEMA)',TX:'Texas Division of Emergency Management (TDEM)',
  UT:'Utah Division of Emergency Management',VT:'Vermont Emergency Management',
  VA:'Virginia Department of Emergency Management (VDEM)',WA:'Washington Military Department, Emergency Management Division',
  WV:'West Virginia Division of Homeland Security & Emergency Management',WI:'Wisconsin Emergency Management (WEM)',
  WY:'Wyoming Office of Homeland Security',DC:'DC Homeland Security & Emergency Management Agency (HSEMA)',
};

async function searchNsgpDeadlines(state, ms = 14000) {
  const year = new Date().getFullYear();
  const q1 = encodeURIComponent(`NSGP nonprofit security grant program ${state} ${year} sub-applicant deadline application open`);
  const q2 = encodeURIComponent(`"nonprofit security grant" "${state}" "sub-applicant" deadline 2024 2023 2022`);
  const [r1, r2] = await Promise.allSettled([
    fetch(`https://s.jina.ai/${q1}`, { headers:{'Accept':'text/plain'}, signal: AbortSignal.timeout(ms) }).then(r => r.ok ? r.text() : null).catch(()=>null),
    fetch(`https://s.jina.ai/${q2}`, { headers:{'Accept':'text/plain'}, signal: AbortSignal.timeout(ms) }).then(r => r.ok ? r.text() : null).catch(()=>null),
  ]);
  return [r1.value, r2.value].filter(Boolean).join('\n\n---\n\n').slice(0, 6000) || null;
} = `You are preparing pre-call notes for an NPSA (Nonprofit Security Advisors) sales meeting. You are given structured meeting information (from a form the rep filled out), plus — when available — text scraped from the organization's website to help you verify attendee titles, mission, and campus addresses.

Produce a polished, scannable pre-call briefing that a sales rep can read live during the call. OUTPUT FORMAT IS MARKDOWN. Follow the exact structure and rules below.

MUST-FOLLOW RULES:
1. Always show meeting time in CST. If another timezone is provided, convert it and show only CST.
2. Default Meeting Host is always Brad Lynde unless another name is explicitly specified.
3. Label the organization's website "School Website" for schools, "Church Website" for churches, "Website" otherwise.
4. NEVER fabricate addresses, titles, phone numbers, mission statements, or facts. Anything not verifiable from the provided information or website text must be written as "TBD". Do not guess.
5. For attendee titles: confirm from the website text first. If a title cannot be verified, write "Title TBD" — never invent one.
6. List every campus/property/location found on the website with its complete postal address. If none can be verified, write "TBD".
7. Keep the fillable sections present with their headings even when empty (the rep fills these in live): Strategic Insights, Top Three Security Wish List Items.
8. Keep the briefing tight and useful — short sentences, no filler, no marketing fluff. Prefer bullets over paragraphs except in the Objective and Overview.

OUTPUT EXACTLY THIS MARKDOWN STRUCTURE (replace the {placeholders}; omit a bracketed line entirely if it would just say TBD with no value, EXCEPT where a rule says to keep it):

# {Organization Name} — {STATE ABBR}
**{Weekday, Month DD, YYYY · H:MM AM/PM CST}** · NPSA 30-Minute Introduction Call

## Meeting Objective
{2-3 sentences: understand the org's current security posture and priorities, and position both Federal and State NSGP grant funding to support their planned upgrades and drivers. Tailor to anything specific the rep noted.}

## NSGP Funding Snapshot
- **Potential Award:** {Count the verified campus/property locations found; multiply by $150,000. Write: "Up to $X (N location(s) × $150,000 federal cap per site)". If campus count is unknown, use 1 as a conservative baseline and note it.}
- **{State} Sub-Applicant Deadline:** {If the NSGP deadline data contains a specific published date for the current or upcoming cycle, use it and label it "(confirmed)". If only historical dates are available, list the last 2–3 years of confirmed sub-applicant deadlines and project the next window as "~{month range} {year} (projected)". If no data at all, write "TBD — verify with {SAA name}".}
- **State Program:** {SAA name from the provided data}
- **Urgency Frame:** {One sharp sentence for the rep to use: position the projected or confirmed deadline relative to today. E.g. "Based on 3 years of history, {State} opens sub-applicant applications in {month} — this call puts {Org} in position to apply before that window."}

## Organization Overview
{2-4 sentences synthesized from the website: what the organization is, who/how many it serves, its location and size, and why it is a strong NSGP candidate. Weave in a one-line mission/values paraphrase if the site states it. If the website was unavailable, write "TBD — website could not be researched."}

## Meeting Details
- **Date & Time:** {converted CST time}
- **Host:** Brad Lynde
- **Location:** Video Web Conference
- **Organization:** {Org Name}
- **{School/Church/}Website:** {URL or TBD}
- **Contact Phone:** {use the attendee's phone number if available; otherwise TBD}

## Attendees
**{Organization Name}**
{For each org attendee: Full Name | Title (or "Title TBD") | Email | Phone}
**NPSA**
Brad Lynde | Managing Partner, NPSA | brad@lyndeconsulting.com
**Partners**
{Partner attendees if any, otherwise: None}

## Verified Campus / Property Locations
{For each: **{Site name}** — {full postal address}. If none verified: TBD}

## Stated Needs & Drivers
{Only if the rep's notes or input mention specific needs/drivers. Bullet the needs (e.g. upgrade cameras, access control, doors/gates) and, under a bold "Drivers:" line, bullet what's prompting this (e.g. recent threat, leadership initiative). If nothing was stated, omit this entire section.}

## Key Talking Points
- Align the organization's threat narrative with NSGP risk-based scoring
- Position planned upgrades as highly fundable under Federal and State NSGP
- Confirm campus layout and building count
- Identify existing security system gaps
- Understand the decision-making process and timeline
{Add 1-2 tailored points if the input supports them.}

## Strategic Insights
{0-2 short bullets ONLY if there is a strong, verifiable signal worth flagging to the rep; otherwise leave this section empty for the rep to complete.}

## Discovery Questions to Ask
1. Do you expect to expand your facility, remodel, or build within the next few years?

2. Do you have any close affiliations with other {churches and Christian schools / schools / organizations} that might benefit from this?

{Add 1-3 tailored discovery questions based on the org type and any stated needs. Put a blank line after each question so the rep has space for handwritten notes.}

## Top Three Security Wish List Items
1.

2.

3.

## Next Steps (Post-Call)
Send a follow-up email including:
1. Engagement Letter
2. Brochure
3. Scheduling link — if a second appointment has not been booked

## Video Conference Details
- **Link:** {Conference link or TBD}
- **Meeting ID:** {ID or TBD}
- **Passcode:** {Passcode or TBD}`;

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

app.post('/api/precall/docx', async (req, res) => {
  const { html, filename } = req.body || {};
  if (!html) return res.status(400).json({ error: 'No HTML provided' });
  try {
    const buffer = await HTMLtoDOCX(html, null, {
      title: filename || 'Pre-Call Notes',
      margins: { top: 720, right: 1080, bottom: 720, left: 1080 },
      font: 'Calibri',
      fontSize: 22,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${(filename||'Pre-Call Notes').replace(/"/g,"'")}.docx"`);
    res.send(buffer);
  } catch(e) {
    console.error('DOCX error:', e.message);
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

    // Fallback: derive website from attendee email domains
    // e.g. michael@calumetstreet.org → try https://calumetstreet.org
    if (!resolvedWebsite && attendees?.length) {
      const genericDomains = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','live.com','msn.com','me.com']);
      for (const att of (attendees || [])) {
        const domain = att?.email?.split('@')[1]?.toLowerCase();
        if (domain && !genericDomains.has(domain)) {
          const candidate = normalizeBaseUrl(`https://${domain}`);
          if (candidate) {
            const test = await fetchViaJina(candidate);
            if (test && test.length > 200) { resolvedWebsite = candidate; break; }
          }
        }
      }
    }

    // Fetch site content + NSGP deadline data in parallel
    const saaName = STATE_SAA[orgState?.toUpperCase()] || (orgState ? `${orgState} State Administering Agency` : null);
    let siteText = '';
    let nsgpDeadlineResults = null;

    await Promise.all([
      // Website scraping
      (async () => {
        if (!resolvedWebsite) return;
        const paths = ['', '/about', '/about-us', '/staff', '/leadership', '/team', '/our-church', '/locations', '/campuses', '/contact'];
        const pages = await Promise.allSettled(paths.map(p => fetchViaJina(`${resolvedWebsite}${p}`)));
        siteText = pages
          .filter(r => r.status === 'fulfilled' && r.value)
          .map(r => r.value)
          .join('\n\n')
          .slice(0, 20000);
      })(),
      // NSGP deadline search (only if we have a state)
      (async () => {
        if (!orgState) return;
        nsgpDeadlineResults = await searchNsgpDeadlines(orgState);
      })(),
    ]);

    // Build structured context block
    const attendeeLines = (attendees || [])
      .filter(a => a && a.name)
      .map(a => `  ${a.name} | ${a.email || ''} | ${a.phone || ''}`)
      .join('\n');

    const nsgpBlock = orgState ? [
      `NSGP GRANT FUNDING DATA:`,
      `State: ${orgState}`,
      `State Administering Agency (SAA): ${saaName}`,
      `Federal award cap: $150,000 per physical site/location`,
      ``,
      nsgpDeadlineResults
        ? `DEADLINE SEARCH RESULTS (use to find published or historical sub-applicant deadlines — extract specific dates if present):\n${nsgpDeadlineResults}`
        : `DEADLINE SEARCH RESULTS: none returned — use SAA name in the TBD note`,
    ].join('\n') : null;

    const context = [
      `MEETING INFORMATION:`,
      `Organization: ${orgName || 'Unknown'}`,
      `Type: ${orgType || 'unknown'}`,
      `State: ${orgState || 'unknown'}`,
      `Date: ${meetingDate || 'TBD'}`,
      `Time: ${meetingTime || 'TBD'} ${meetingTimezone || 'CST'}`,
      `Conference Link: ${zoomUrl || 'TBD'}`,
      `Meeting ID: ${zoomId || 'TBD'}`,
      `Passcode: ${zoomPassword || 'TBD'}`,
      `Website: ${resolvedWebsite || 'not found'}`,
      ``,
      `ATTENDEES:`,
      attendeeLines || '  (none provided)',
      extraNotes ? `\nADDITIONAL CONTEXT FROM REP:\n${extraNotes}` : '',
      nsgpBlock ? `\n${nsgpBlock}` : '',
      ``,
      resolvedWebsite
        ? `WEBSITE CONTENT (${resolvedWebsite}) — use to verify attendee titles, campus addresses, mission statement. Do NOT invent facts not found here:`
        : `WEBSITE CONTENT: unavailable — mark website-dependent fields as TBD`,
      siteText || '(website could not be fetched)',
    ].filter(l => l !== null).join('\n');

    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4500,
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
