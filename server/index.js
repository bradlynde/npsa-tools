import express from 'express';
import { OpenAI } from 'openai';
import { repairDocx, stripXmlIllegal } from './docx-repair.js';
import { preserveInlineSpacing } from './docx-style.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import pg from 'pg';
import HTMLtoDOCX from 'html-to-docx';
import { registerMarketing } from './marketing.js';
import { listUpcomingBookings, getBooking, roundRobinSchedulingUrl } from './precall-bookings.js';
import {
  buildMeetingDetails, buildAttendees, buildVideoConference,
  writeInLines, writeInField, substituteBlocks, fillEmptySections, formatCentral, NPSA_TITLES,
} from './precall-facts.js';
import {
  ensureDeadlineSchema, listDeadlines, upsertDeadline, deleteDeadline,
  deadlinesForState, renderDeadlines, SAA_BY_STATE, STATE_PROGRAMS_BY_STATE, STATE_REFERENCE,
} from './nsgp-deadlines.js';
import { registerSalesforceConnector } from './connectors/salesforce.js';
import { registerMcp } from './mcp.js';
import { ensureIntakeSchema, createIntakeStore, registerIntake } from './intake.js';
import crypto from 'crypto';

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
  ensureDeadlineSchema(pool).catch(err => console.error('Deadline init error:', err.message));
  ensureIntakeSchema(pool).catch(err => console.error('Intake init error:', err.message));
}

// Minted per process and never stored: the MCP layer presents it on its loopback
// calls to the grant-client routes, which is what lets those routes require a key
// from outside without a second secret to configure or rotate.
const INTERNAL_KEY = crypto.randomBytes(24).toString('hex');

// The scheduled Salesforce sync delivers its whole record set in one request, which
// outgrows the 100kb default as the business does. This has to be registered BEFORE
// the general parser: middleware runs in registration order, so whichever json()
// sees the request first is the one whose limit applies — a limit set down on the
// route itself would never get a look in. body-parser marks the request as read, so
// the general parser below simply skips what this one already handled.
app.use('/api/marketing/sync/push', express.json({ limit: '10mb' }));
// A full intake seed (592 keys of prose) can pass 100kb; same trick, smaller limit.
app.use(['/api/clients', '/api/intake'], express.json({ limit: '2mb' }));
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
      headers: {
        'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-No-Cache': 'true',
        // Jina's unauthenticated tier is rate-limited per IP, and every rep
        // generating notes shares one server address. A key raises that ceiling.
        ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
      },
    });
    if (!r.ok) { console.warn(`[precall] jina ${r.status} for ${url}`); return null; }
    return (await r.text()).slice(0, 8000);
  } catch (e) {
    console.warn(`[precall] jina failed for ${url}: ${e.name === 'AbortError' ? `timeout after ${ms}ms` : e.message}`);
    return null;
  } finally { clearTimeout(t); }
}

/** Crude tag stripper — enough to feed a model, not enough to render. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchDirect(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      // Some church and school hosts serve a block page to an unrecognised agent.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NPSA-PreCall/1.0)', 'Accept': 'text/html' },
    });
    if (!r.ok) { console.warn(`[precall] direct ${r.status} for ${url}`); return null; }
    if (!/text\/html|text\/plain/i.test(r.headers.get('content-type') || '')) return null;
    return htmlToText(await r.text()).slice(0, 8000);
  } catch (e) {
    console.warn(`[precall] direct failed for ${url}: ${e.name === 'AbortError' ? `timeout after ${ms}ms` : e.message}`);
    return null;
  } finally { clearTimeout(t); }
}

/**
 * Reads a page, trying the site itself before the third-party reader.
 *
 * Everything used to go through Jina alone, and every failure was swallowed by a
 * bare `catch { return null }`. When it stopped answering, the briefing came back
 * with the website, the overview, the campus addresses, the state, the
 * administering agency and the deadlines all reading TBD — a whole document lost
 * to one dependency, with nothing in the logs to say why.
 *
 * Most church and school sites are ordinary server-rendered HTML that a plain GET
 * handles perfectly well, so the direct fetch is both the faster path and the one
 * that does not share a rate limit with every other rep. Jina stays as the
 * fallback, where it earns its keep on JS-rendered sites.
 */
async function fetchPage(url) {
  const direct = await fetchDirect(url);
  if (direct && direct.length > 400) return direct;
  const viaJina = await fetchViaJina(url);
  return viaJina || direct || null;
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

// A personal mailbox says nothing about the organisation's domain.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com',
  'live.com','msn.com','me.com','comcast.net','att.net','verizon.net','sbcglobal.net',
  'protonmail.com','proton.me','mac.com','ymail.com','googlemail.com',
]);

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

// ── NSGP State Administering Agency (SAA) and state-funded programs ──────────
//
// Both of these used to be written out here from memory, and both were wrong in
// ways that reached the page. Hawaii's SAA is the Office of Homeland Security
// under the Department of Law Enforcement, not HI-EMA; Kansas's is the Highway
// Patrol, not a division of emergency management; Massachusetts is the Office of
// Grants and Research, not MEMA; South Carolina is SLED; New Hampshire is the
// Department of Safety's grants bureau. A briefing naming the wrong agency sends
// a rep somewhere confidently wrong.
//
// The state-funded list was worse for being short rather than wrong: only IL, CA
// and NY were recorded, so briefings for AZ, CO, CT, FL, GA, LA, MD, MA, MN, NE,
// NV, NJ, OH, PA and TN never mentioned a funding source those clients qualify
// for — in California's case a track worth more per site than the federal one.
//
// Both now come from NPSA's own grant-knowledge base; see server/nsgp-data.json.
const STATE_SAA = SAA_BY_STATE;

// Keyed by state, each entry a LIST of programs — several states run more than
// one (New Jersey and Massachusetts each have an equipment track and a personnel
// track). A program may cap per site, per applicant, or both, so a null of either
// is normal and callers have to cope with it.
const STATE_FUNDED_PROGRAMS = STATE_PROGRAMS_BY_STATE;

const PRECALL_MASTER_PROMPT = `You are preparing pre-call notes for an NPSA (Nonprofit Security Advisors) sales meeting. You are given structured meeting information (from a form the rep filled out), plus — when available — text scraped from the organization's website to help you verify attendee titles, mission, and campus addresses.

Produce a polished, scannable pre-call briefing that a sales rep can read live during the call. OUTPUT FORMAT IS MARKDOWN. Follow the exact structure and rules below.

MUST-FOLLOW RULES:
1. SUBSTITUTION TOKENS. Some sections are filled in by the application, not by you, because they contain facts the client submitted and those must appear exactly as submitted. Where the structure below shows a token such as <<MEETING_DETAILS>>, output that token ALONE on its own line — no heading text of your own, no surrounding prose, no explanation, and never your own version of the content. Reproduce the token character for character. The application replaces it after you finish.
2. NEVER fabricate addresses, titles, phone numbers, mission statements, or facts. Anything not verifiable from the provided information or website text must be written as "TBD". Do not guess.
3. For attendee titles: confirm from the website text. If a title cannot be verified, do not invent one.
4. Label the organization's website "School Website" for schools, "Church Website" for churches, "Website" otherwise.
5. List every campus/property/location found on the website with its complete postal address. If none can be verified, write "TBD".
6. Keep the fillable sections present with their headings even when empty (the rep fills these in live): Strategic Insights, # Attendees All Campuses, Top Three Security Wish List Items. "# Attendees All Campuses" asks how many people the organization draws across every campus — it is a number the rep gets on the call, never one you estimate.
7. Keep the briefing tight and useful — short sentences, no filler, no marketing fluff. Prefer bullets over paragraphs except in the Objective and Overview.

OUTPUT EXACTLY THIS MARKDOWN STRUCTURE (replace the {placeholders}; omit a bracketed line entirely if it would just say TBD with no value, EXCEPT where a rule says to keep it):

# {Organization Name} — {STATE ABBR}
**{Weekday, Month DD, YYYY · H:MM AM/PM CST}** · NPSA 30-Minute Introduction Call

## Before You Dial
{Scan the full briefing for anything that is TBD or needs live confirmation. List ONLY the items that are actually missing or uncertain — skip this section entirely if nothing is TBD. Format as checkboxes. Examples of things to include: unverified attendee title, missing campus address, unknown campus count, missing contact phone. Keep each item to one line.}
- [ ] {item 1}
- [ ] {item 2}

## Meeting Objective
{2-3 sentences: understand the org's current security posture and priorities, and position both Federal and State NSGP grant funding to support their planned upgrades and drivers. Tailor to anything specific the rep noted.}

## NSGP Funding Snapshot
{Show BOTH funding tracks from the NSGP GRANT FUNDING DATA. The Federal NSGP track ALWAYS applies. If the data lists a PROGRAM 2 (state-funded program), show it as a second, stackable source. If the data says the state has no separate program, show only the federal track and add a one-line note that the state has none. Let N be the number of verified campus/property locations — if unknown use 1 and say so. This paragraph is an instruction: do not reproduce any of it in your output, and do not write the words "PROGRAM 2", "Let N" or "GRANT FUNDING DATA" anywhere.}

**Federal NSGP**
- **Potential Award:** {N × $200,000 = "Up to $X (N location(s) × $200,000 per site)".}
- **Administered By:** {SAA name from the data}

{Then ONE block per state-funded program listed in the data — some states run two. Omit entirely if the data says the state has none.}
**{state program acronym} (State-Funded)**
- **Potential Award:** {Use the cap EXACTLY as the data words it. If the cap is per site, multiply by N locations. If the data says "per applicant (NOT per site)", do NOT multiply — state the flat amount. If the data says the cap is not published, write "Cap not published — confirm with the administering agency" and give no figure.}
- **Program:** {state program full name from the data}
- **Note:** {the program's Note line from the data, if there is one — these carry the eligibility catches, e.g. schools-only, personnel-only, or owning the building}

- **Combined Potential:** {ONLY if the data marks a state program "Stackable with federal NSGP." — then sum that track with federal. If the data says NOT stackable, do not sum: say instead that the state program is an alternative to federal NSGP and the organization would choose one. If stackability is unconfirmed, omit this line entirely.}
- **Urgency Frame:** {One sharp sentence the rep can use, framing why this call is well timed and noting that the organization may be able to pursue both federal and state funding where applicable. Do NOT state, repeat or estimate any deadline date here — dates appear only in the Deadlines block above, which is filled in by the application. Refer to timing in general terms instead, e.g. "with the next window approaching".}

## NSGP Deadlines
<<FUNDING_DEADLINES>>

## Organization Overview
{2-4 sentences synthesized from the website: what the organization is, who/how many it serves, its location and size, and why it is a strong NSGP candidate. Weave in a one-line mission/values paraphrase if the site states it. If the site could not be read, do NOT describe the organisation from memory — write one line naming the address so the rep can open it, e.g. "Could not read example.org automatically — open it before the call." If no website is known at all, write "TBD — no website found."}

## Meeting Details
<<MEETING_DETAILS>>

## Attendees
<<ATTENDEES>>

## Verified Campus / Property Locations
{For each: **{Site name}** — {full postal address}. If none verified: TBD}

## # Attendees All Campuses
<<ATTENDEE_COUNT>>

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
<<WISH_LIST>>

## Next Steps (Post-Call)
Send a follow-up email including:
1. Engagement Letter
2. Brochure
3. Scheduling link — if a second appointment has not been booked

## Video Conference Details
<<VIDEO_CONFERENCE>>`;

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

app.post('/api/precall/followup', async (req, res) => {
  const { formData, notes, preCallNotes, eventUri,
          orgName: legacyOrg, contactName: legacyCN, contactEmail: legacyCE } = req.body || {};
  const notesText = notes || preCallNotes || '';
  if (!notesText) return res.status(400).json({ error: 'No notes provided' });
  const org = (formData?.orgName || legacyOrg || '').trim();
  const attendee0 = formData?.attendees?.[0] || {};
  const contactName = attendee0.name || legacyCN || '';
  const contactEmail = attendee0.email || legacyCE || '';
  const firstName = contactName.split(' ')[0] || 'there';

  /*
   * Whose email this is. Read from the booking rather than assumed, for the same
   * reason the attendee list is: the rep who ran the call is often not Brad.
   *
   * The scheduling link is deliberately NOT the sender's. Clients book the team
   * through one round robin, so that is what a follow-up offers — an individual's
   * page books that person and skips the rotation. The default no longer carries
   * a personal link either, for the same reason.
   */
  let sender = { name: 'Brad Lynde', email: 'brad@lyndeconsulting.com',
                 title: 'Managing Partner, NPSA', schedulingUrl: null };
  sender.schedulingUrl = await roundRobinSchedulingUrl();
  if (eventUri) {
    try {
      const b = await getBooking(eventUri);
      if (b?.host?.name || b?.host?.email) {
        sender = {
          name: b.host.name || sender.name,
          email: b.host.email || '',
          title: NPSA_TITLES[String(b.host.email || '').toLowerCase()] || 'NPSA',
          schedulingUrl: b.host.schedulingUrl || sender.schedulingUrl,
        };
      }
    } catch (e) { console.error('Follow-up host lookup failed:', e.message); }
  }
  const signOff = [sender.name, sender.title, sender.email].filter(Boolean).join(' | ');

  try {
    const client = getOpenAI();
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 800,
      messages: [{
        role: 'system',
        content: `You are drafting a post-call follow-up email on behalf of ${sender.name} at NPSA (Nonprofit Security Advisors), sent after an introductory call with a nonprofit prospect.

Write a concise, warm, professional email. Rules:
1. Subject line on the first line, formatted as: Subject: {subject}
2. Blank line, then the email body.
3. Address the contact by first name (${firstName}).
4. Thank them for the call and reference the organization by name (${org || 'their organization'}).
5. Reference the NSGP grant opportunity — pull the dollar amount from the pre-call notes if present. Only mention a deadline if the notes state one; never estimate or invent a date.
6. Tell them the Engagement Letter and Brochure are attached for review.
7. ${sender.schedulingUrl ? `Invite them to book a follow-up using this scheduling link: ${sender.schedulingUrl}` : 'Invite them to reply to arrange a follow-up. Do NOT invent a scheduling link.'}
8. Close exactly with: ${signOff}
9. Never include a phone number — you have not been given one, and an invented one would reach a stranger.
10. Keep it under 200 words. No fluff, no bullet points — flowing prose paragraphs only.`
      }, {
        role: 'user',
        content: `Contact: ${contactName} (${contactEmail})\nOrganization: ${org}\n\nPRE-CALL NOTES FOR CONTEXT:\n${notesText.slice(0, 3000)}`
      }]
    });
    res.json({ email: completion.choices[0]?.message?.content || '' });
  } catch(e) {
    console.error('Follow-up email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/precall/docx', async (req, res) => {
  const { html, filename } = req.body || {};
  if (!html) return res.status(400).json({ error: 'No HTML provided' });
  try {
    // html-to-docx chokes on certain CSS (border-bottom, text-transform, decimal line-height)
    // Strip the stylesheet entirely — the library applies its own safe defaults
    // Illegal characters are stripped BEFORE conversion as well as after. The
    // repair pass would catch them either way, but the notes travel through
    // marked, html-to-docx and JSZip first, and it is worth not asking three
    // libraries to be careful with a character XML does not permit at all.
    const safeHtml = stripXmlIllegal(preserveInlineSpacing(html.replace(/<style[\s\S]*?<\/style>/gi, '')));
    const docTitle = stripXmlIllegal(filename || 'Pre-Call Notes').trim() || 'Pre-Call Notes';
    const generated = await HTMLtoDOCX(safeHtml, null, {
      title: docTitle,
      // One-inch margins and Arial, matching the copy of these notes Brad marked
      // up in Word — that document is the reference for how this should look.
      // All six. html-to-docx interpolates margins.header/footer/gutter straight
      // into w:pgMar, so omitting them writes the literal string "undefined" into
      // a measurement attribute and the document stops being schema-valid.
      margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
      font: 'Arial',
      fontSize: 21,
      lineHeight: 240,
    });
    // html-to-docx emits paragraph properties in source order; OOXML fixes that
    // order and Word rejects the whole file when it is wrong. Everything else
    // opens it fine, which is why this looked like a problem with Brad's Word.
    const buffer = await repairDocx(generated, { brand: true });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // A control character in the organisation name would make Node throw on the
    // header rather than send the file, so the name is cleaned here too — this is
    // the one place a bad character stops the download outright.
    res.setHeader('Content-Disposition', `attachment; filename="${docTitle.replace(/"/g, "'")}.docx"`);
    res.send(buffer);
  } catch(e) {
    console.error('DOCX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Upcoming bookings to start from. Cached briefly: several reps opening the tool
// at the top of the hour is otherwise one Calendly call per event per rep, and the
// list does not change minute to minute.
let bookingCache = { at: 0, data: null };
app.get('/api/precall/bookings', async (req, res) => {
  if (!process.env.CALENDLY_API_TOKEN) {
    return res.status(503).json({ error: 'Calendly is not connected', bookings: [] });
  }
  try {
    const fresh = req.query.refresh === '1';
    if (!fresh && bookingCache.data && Date.now() - bookingCache.at < 60_000) {
      return res.json({ bookings: bookingCache.data, cached: true });
    }
    const bookings = await listUpcomingBookings({ limit: 40 });
    bookingCache = { at: Date.now(), data: bookings };
    res.json({ bookings, cached: false });
  } catch (e) {
    console.error('Booking list error:', e.message);
    res.status(502).json({ error: e.message, bookings: [] });
  }
});

// ── Curated NSGP deadlines ────────────────────────────────────────────────────
app.get('/api/precall/deadlines', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  // The reference travels with the dates: the editor shows one state at a time,
  // and a date without its SAA, its state-funded programs and its freshness is
  // the shape of the table that was too hard to keep current.
  try { res.json({ deadlines: await listDeadlines(pool), reference: STATE_REFERENCE }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/precall/deadlines', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const id = await upsertDeadline(pool, req.body || {});
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/precall/deadlines/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try { await deleteDeadline(pool, req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/precall', async (req, res) => {
  const { formData, calendlyText, eventUri } = req.body || {};
  if (!formData && !calendlyText?.trim() && !eventUri) {
    return res.status(400).json({ error: 'No input provided' });
  }
  try {
    const client = getOpenAI();

    let orgName, orgType, orgState, websiteUrl, meetingDate, meetingTime, meetingTimezone,
        zoomUrl, zoomId, zoomPassword, attendees, extraNotes;

    // The booking is re-read at generation time rather than trusted from the
    // list the rep clicked, so a meeting rescheduled in between is caught.
    let booking = null;
    if (eventUri) {
      try { booking = await getBooking(eventUri); }
      catch (e) { console.error('Booking fetch failed:', e.message); }
    }

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

    // Calendly wins over anything the rep typed or a model guessed. The booking is
    // what the client actually submitted, so where the two disagree the booking is
    // right by definition — a rep's typo and a model's invention lose to it equally.
    if (booking) {
      const f = booking.facts;
      orgName    = f.orgName    || orgName;
      orgState   = f.orgState   || orgState;
      websiteUrl = f.websiteUrl || websiteUrl;
      zoomUrl    = f.location?.joinUrl   || zoomUrl;
      zoomId     = f.location?.meetingId || zoomId;
      zoomPassword = f.location?.passcode || zoomPassword;
      attendees = [
        { name: f.inviteeName, email: f.inviteeEmail, phone: f.inviteePhone },
        ...(f.guests || []).map(email => ({ name: null, email, phone: null })),
      ];
    }

    // One shape for both routes, so the sections rendered from it do not care
    // whether the booking came from Calendly or was typed in by hand.
    const facts = booking ? booking.facts : {
      orgName, orgState, websiteUrl,
      inviteeName:  attendees?.[0]?.name  || null,
      inviteeEmail: attendees?.[0]?.email || null,
      inviteePhone: attendees?.[0]?.phone || null,
      inviteeTimezone: null,
      startTime: meetingDate && meetingTime ? `${meetingDate}T${meetingTime}:00` : null,
      guests: (attendees || []).slice(1).map(a => a.email).filter(Boolean),
      location: { kind: 'custom', label: 'Video Web Conference', joinUrl: zoomUrl || null,
                  meetingId: zoomId || null, passcode: zoomPassword || null },
      questions: [],
    };

    // Resolve the website. The attendee's own email domain is tried BEFORE the web
    // search, because kwhitezell@olph1.org states the organisation's domain outright
    // — there is nothing to infer and nothing to get wrong. The search is a real
    // guess made from search-result text, so it belongs last, not first.
    let resolvedWebsite = normalizeBaseUrl(websiteUrl);

    if (!resolvedWebsite) {
      // The invitee's domain leads: a guest may be a consultant or a broker at a
      // different organisation entirely, which is not the site to research.
      const domains = [];
      for (const att of (attendees || [])) {
        const d = att?.email?.split('@')[1]?.toLowerCase();
        if (d && !GENERIC_EMAIL_DOMAINS.has(d) && !domains.includes(d)) domains.push(d);
      }
      // Taken as the answer, NOT probed first. kwhitezell@olph1.org states the
      // organisation's domain — that is a fact off the booking, not a candidate
      // needing confirmation. The previous version only accepted it if a scrape of
      // it came back over 200 characters, which made a scraper outage look like
      // evidence the domain was wrong: the briefing then reported no website at
      // all for an organisation whose website was sitting in the invitee's own
      // address. Whether the site can be READ is a separate question, tracked
      // below, and a site nobody can read is still the site.
      if (domains.length) resolvedWebsite = normalizeBaseUrl(`https://${domains[0]}`);
    }

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

    let siteText = '';
    let deadlineRows = [];

    if (resolvedWebsite) {
      const paths = ['', '/about', '/about-us', '/staff', '/leadership', '/team', '/our-church', '/locations', '/campuses', '/contact'];
      let pages = await Promise.allSettled(paths.map(p => fetchPage(`${resolvedWebsite}${p}`)));
      let ok = pages.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

      // Plenty of parish and school sites answer on one of apex/www and not the
      // other. Retrying the homepage on the other host is cheap next to losing the
      // whole research pass, which is what used to happen.
      if (!ok.length) {
        const host = new URL(resolvedWebsite).host;
        const alt = host.startsWith('www.')
          ? resolvedWebsite.replace('://www.', '://')
          : resolvedWebsite.replace('://', '://www.');
        console.warn(`[precall] nothing readable at ${resolvedWebsite}, trying ${alt}`);
        pages = await Promise.allSettled(paths.slice(0, 4).map(p => fetchPage(`${alt}${p}`)));
        ok = pages.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
        if (ok.length) resolvedWebsite = alt;
      }

      siteText = ok.join('\n\n').slice(0, 20000);
      if (!siteText) console.warn(`[precall] no page of ${resolvedWebsite} could be read`);
    }

    // Guests arrive as an email and nothing else, so a filter on name — which is
    // what this used to do — dropped exactly the person Brad asked to have looked up.
    const attendeeLines = (attendees || [])
      .filter(a => a && (a.name || a.email))
      .map(a => `  ${a.name || '(name not given)'} | ${a.email || ''} | ${a.phone || ''}`)
      .join('\n');

    // Who the attendees are, researched from the website. Separated from the notes
    // themselves so the answer comes back as data that can be labelled unverified,
    // rather than as prose already woven in past the point of telling apart.
    let research = {};
    const toResearch = (attendees || []).filter(a => a?.email);
    if (siteText) {
      try {
        const r = await client.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 700,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content:
            `From the website text below, return JSON {"org_state":null,"people":[{"email":"","name":null,"title":null,"evidence":null}]}.\n` +
            `"org_state": the 2-letter US state abbreviation of the organisation's own address, from a postal address or contact page. Null if the site does not state one.\n` +
            `For each person: use ONLY the website text. "name" only when the site names the person — for an email like dayna@example.org, look for a matching first name on a staff or leadership page. ` +
            `"title" only when the site states their role. "evidence" is a short quote from the site supporting it. ` +
            `Use null for anything the site does not support. Never guess from the email address alone.\n\n` +
            `PEOPLE:\n${toResearch.map(a => `${a.email}${a.name ? ` (${a.name})` : ''}`).join('\n') || '(none)'}\n\n` +
            `WEBSITE TEXT:\n${siteText.slice(0, 14000)}` }],
        });
        const parsed = JSON.parse(r.choices[0]?.message?.content || '{}');
        for (const p of (parsed.people || [])) {
          if (p?.email) research[String(p.email).toLowerCase()] = p;
        }
        // The state is not a cosmetic field. It selects the SAA, the deadline rows,
        // and whether a stackable state-funded program is shown at all — so a blank
        // one silently cost the Our Lady of Perpetual Help briefing its administering
        // agency, its deadlines, AND California's $250k-per-site CSNSGP track. The
        // booking form does not ask for it, so derive it from the organisation's own
        // published address rather than leaving it to the rep to remember.
        if (!orgState && /^[A-Za-z]{2}$/.test(String(parsed.org_state || '').trim())) {
          orgState = String(parsed.org_state).trim().toUpperCase();
          if (!STATE_SAA[orgState]) orgState = null;   // a real abbreviation, or none
        }
      } catch (e) { console.error('Attendee research failed:', e.message); }
    }

    // Deadlines come from the curated table now. The web search this replaces is
    // gone rather than kept as a fallback: scraping search results for dates is
    // exactly what produced the section Brad called inaccurate, and "not recorded —
    // confirm with the SAA" is more use to a rep than a confident wrong date.
    const saaName = STATE_SAA[orgState?.toUpperCase()] || (orgState ? `${orgState} State Administering Agency` : null);
    if (orgState && pool) {
      try { deadlineRows = await deadlinesForState(pool, orgState); }
      catch (e) { console.error('Deadline lookup failed:', e.message); }
    }

    const statePrograms = STATE_FUNDED_PROGRAMS[orgState?.toUpperCase()] || [];

    // A cap can be per site, per applicant, or unpublished, and the difference is
    // the difference between "up to $250,000 per building" and "up to $50,000 full
    // stop". Stating the wrong one inflates the number a rep quotes on a call.
    const capLine = (p) => {
      if (p.perSite && p.perApplicant) return `$${p.perSite.toLocaleString()} per site, up to $${p.perApplicant.toLocaleString()} per applicant`;
      if (p.perSite) return `$${p.perSite.toLocaleString()} per site`;
      if (p.perApplicant) return `$${p.perApplicant.toLocaleString()} per applicant (NOT per site)`;
      return 'cap not published — do not state an amount';
    };
    // Several of these are alternatives to federal NSGP rather than additions:
    // Arizona, Colorado and Nebraska all bar applicants who have federal awards.
    // Presenting them as stackable would be a straightforwardly wrong pitch.
    const stackLine = (p) => p.stackable === true
      ? 'Stackable with federal NSGP.'
      : p.stackable === false
        ? 'NOT stackable — this is an ALTERNATIVE to federal NSGP, and eligibility usually depends on NOT holding a federal award. Do not present the two as additive.'
        : 'Stackability not confirmed — do not claim the two can be combined.';

    /*
     * Stackability against the federal award is not the only way two numbers get
     * wrongly added together. New Jersey runs two state programs, each of which
     * stacks with federal NSGP, and an organization may be awarded only one of
     * them — so the honest ceiling is $100,000, not $120,000.
     */
    const exclusiveLine = (p) => p.exclusiveWith?.length
      ? `  MUTUALLY EXCLUSIVE with ${p.exclusiveWith.join(', ')} — the organization may apply to both but can be AWARDED only one state program per fiscal year. Do not add these two caps together.`
      : null;

    // A program with published caps and no live cycle is the quietest way to be
    // wrong: everything reads correctly and the money is not there.
    const availabilityLine = (p) => p.dormant
      ? `  AVAILABILITY: dormant — ${p.availabilityNote} Do not present this as currently available funding; mention it only as something to watch.`
      : p.unconfirmed
        ? `  AVAILABILITY: unconfirmed — ${p.availabilityNote} Do not present this as available funding.`
        : null;

    const nsgpBlock = orgState ? [
      `NSGP GRANT FUNDING DATA:`,
      `State: ${orgState}`,
      ``,
      `PROGRAM 1 — Federal NSGP (always applicable):`,
      `  Program: Federal Nonprofit Security Grant Program (NSGP)`,
      `  Award cap: $200,000 per physical site/location`,
      `  Administered in-state by (SAA): ${saaName}`,
      statePrograms.length
        ? statePrograms.map((p, i) => [
            ``,
            `PROGRAM ${i + 2} — State-funded (${orgState}):`,
            `  Program: ${p.name} (${p.acronym})`,
            `  Award cap: ${capLine(p)}`,
            `  ${stackLine(p)}`,
            exclusiveLine(p),
            availabilityLine(p),
            p.administeredBy ? `  Administered by ${p.administeredBy} — NOT the SAA named above. Point the client at the right office.` : null,
            p.note ? `  Note: ${p.note}` : null,
          ].filter(Boolean).join('\n')).join('\n')
        : `\nSTATE-FUNDED PROGRAMS: ${orgState} does NOT operate a separate state-funded nonprofit security grant program. Federal NSGP is the only track — present only the federal track and note there is no separate state program.`,
      ``,
      `DEADLINES: filled in by the application from a curated table and inserted at the <<FUNDING_DEADLINES>> token. Do NOT write any deadline date anywhere in your output.`,
    ].join('\n') : null;

    const context = [
      `MEETING INFORMATION (background only — the Meeting Details, Attendees and`,
      `Video Conference sections are filled in by the application at their tokens.`,
      `Do not restate any phone number, email address, meeting link, meeting ID or`,
      `passcode anywhere in your output):`,
      `Organization: ${orgName || 'Unknown'}`,
      `Type: ${orgType || 'unknown'}`,
      `State: ${orgState || 'unknown'}`,
      `Meeting: ${formatCentral(facts.startTime) || 'TBD'}`,
      `Website: ${resolvedWebsite || 'not found'}`,
      ``,
      `ATTENDEES (for context when writing the Objective and Overview):`,
      attendeeLines || '  (none provided)',
      (facts.questions || []).length
        ? `\nWHAT THE CLIENT SUBMITTED ON THE BOOKING FORM:\n` +
          facts.questions.map(q => `  ${q.question}: ${q.answer}`).join('\n')
        : '',
      extraNotes ? `\nADDITIONAL CONTEXT FROM REP:\n${extraNotes}` : '',
      nsgpBlock ? `\n${nsgpBlock}` : '',
      ``,
      resolvedWebsite
        ? (siteText
            ? `WEBSITE CONTENT (${resolvedWebsite}) — use to verify attendee titles, campus addresses, mission statement. Do NOT invent facts not found here:`
            // Knowing the address but not being able to read it is a different
            // situation from not knowing it, and the rep can act on the first.
            : `WEBSITE: ${resolvedWebsite} — this is the organisation's site, taken from the attendee's email domain, but it could not be read automatically. Say so and give the rep the address to open themselves. Do NOT describe the organisation from memory.`)
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

    // Everything the client submitted goes in here, after the model has finished
    // and without its involvement. See server/precall-facts.js for why.
    const todayIso = new Date().toISOString().slice(0, 10);
    let notes = substituteBlocks(completion.choices[0]?.message?.content || '', {
      MEETING_DETAILS: {
        heading: 'Meeting Details',
        body: buildMeetingDetails(facts, { orgType, website: resolvedWebsite, hostName: booking?.host?.name }),
      },
      ATTENDEES: { heading: 'Attendees', body: buildAttendees(facts, research, booking?.host) },
      VIDEO_CONFERENCE: { heading: 'Video Conference Details', body: buildVideoConference(facts.location) },
      WISH_LIST: { heading: 'Top Three Security Wish List Items', body: writeInLines(3) },
      // Total attendance across every campus — the figure that sizes the whole
      // engagement. It is a rule for the rep to write on rather than anything the
      // model produces: a plausible-looking congregation size is exactly the kind
      // of invention this pipeline exists to keep off the page.
      ATTENDEE_COUNT: { heading: '# Attendees All Campuses', body: writeInField() },
      // Always supplied when a state is known. An unsupplied token is stripped, and
      // since the model is forbidden from writing dates, that would delete the
      // deadline section altogether rather than degrade it — worse than the
      // inaccurate section this replaced. With no rows, renderDeadlines says so.
      FUNDING_DEADLINES: {
        heading: 'NSGP Deadlines',
        body: orgState
          ? renderDeadlines(deadlineRows, { state: orgState, saaName, todayIso })
          : '- Deadlines depend on the state — set the organization\'s state to see them.',
      },
    });
    notes = fillEmptySections(notes, ['Strategic Insights'], writeInLines(2));

    res.json({
      notes,
      website: resolvedWebsite || null,
      websiteFetched: !!siteText,
      orgName: orgName || null,
      // So the rep can see the booking drove this, and spot a stale selection.
      booking: booking ? { eventUri: booking.eventUri, startTime: booking.startTime,
                           inviteeName: booking.facts.inviteeName,
                           guests: booking.facts.guests } : null,
      deadlinesFromTable: deadlineRows.length > 0,
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

registerMarketing(app, pool);
registerSalesforceConnector(app, pool);
// MCP lives at /mcp, outside /api, so it must be mounted ahead of the SPA
// fallback below or the catch-all would answer for it with index.html.
// Grant clients: team routes keyed, client routes token-only, and the client page
// at /client/:slug — which, like /mcp, has to beat the SPA fallback.
registerIntake(app, {
  store: pool ? createIntakeStore(pool) : null,
  internalKey: INTERNAL_KEY,
  publicBase: process.env.INTAKE_BASE_URL,
  apiBase: process.env.INTAKE_API_BASE || '',
});
registerMcp(app, { port: () => PORT, internalKey: INTERNAL_KEY });

// An API route that does not exist must say so. Without this the fallback below
// answers for it, so a JSON caller gets 200 and a page of HTML — which reads as a
// working endpoint returning the wrong shape rather than an endpoint that is not
// there. A newly added route that has not finished deploying looks, from the
// outside, exactly like the toolbox.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'No such API route', path: req.originalUrl });
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LOE Generator server running on port ${PORT}`);
});
