#!/usr/bin/env node
/*
 * Facts check for the pre-call briefing.
 *
 * Drives the real /api/precall handler with Calendly and Claude replaced by local
 * stand-ins, so the wiring is exercised rather than just its parts.
 *
 * The stub model is deliberately badly behaved: instead of emitting the
 * substitution tokens it invents a contact phone, an attendee and a host — the
 * exact failure that put a wrong phone number on the City Church notes. Every
 * client-submitted value must still win, and the invented ones must be gone.
 *
 * The Calendly payloads are copied from the live API, including the two shapes
 * that broke the first version of the reader: guests hanging off the event rather
 * than the invitee, and a Zoom meeting id wrapped in a union envelope.
 *
 *   node scripts/precall-facts.mjs
 *
 * No credentials and no database needed — which also covers the degraded path
 * where the deadline table is unreachable.
 */
process.env.PORT = '3211';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.CALENDLY_API_TOKEN = 'cal-test';
// Claude is called over real HTTP to a local stand-in of the Messages API, so the
// request the server builds (headers, model, system, thinking) is checked as sent.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3212';
// Every /api route has needed a credential since #266 (server/api-gate.js), and
// this file kept calling without one — so from then on every check below was
// reading a 401 body and failing on it, which says nothing about the notes. A
// team key is the credential the toolbox's own proxies present.
process.env.MCP_API_KEYS = 'precall-facts-key';
const AUTH = { Authorization: 'Bearer precall-facts-key' };

import { marked } from 'marked';

const EVENT = 'https://api.calendly.com/scheduled_events/d14f0255';

// The model deliberately misbehaves: it invents a phone number and a fake
// attendee instead of emitting the tokens. The real values must still win.
const MODEL_OUTPUT = `# Greenland Hills UMC — TX

## Meeting Objective
Understand posture.

## NSGP Funding Snapshot
**Federal NSGP**
- **Potential Award:** Up to $200,000
- **Administered By:** Office of the Governor — Public Safety Office (PSO)

## NSGP Deadlines
<<FUNDING_DEADLINES>>

## Organization Overview
A church in Dallas.

## Meeting Details
- **Contact Phone:** (214) 555-0199
- **Host:** Someone Else

## Attendees
**Greenland Hills UMC**
Imaginary Person | Title TBD

## Strategic Insights

## # Attendees All Campuses
About 1,200 members across two campuses.

## Top Three Security Wish List Items
<<WISH_LIST>>

## Video Conference Details
<<VIDEO_CONFERENCE>>`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url);

  if (u.startsWith('https://api.calendly.com')) {
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/users/jeff')) {
      return json({ resource: { scheduling_url: 'https://calendly.com/jeff-npsa' } });
    }
    if (u.includes('/invitees')) {
      return json({ collection: [{
        uri: `${EVENT}/invitees/993017ba`, email: 'geoffrey@greenlandhills.org',
        name: 'Geoffrey Moore', timezone: 'America/Chicago', text_reminder_number: null,
        questions_and_answers: [
          { question: 'Organization Name', answer: 'Greenland Hills UMC', position: 0 },
          { question: 'Contact Phone Number', answer: '2147089835', position: 1 },
          // The answers the briefing used to lose. They reached the model as
          // context and stopped there, so whether the rep ever saw what the
          // client was worried about came down to whether a paragraph happened
          // to mention it.
          { question: 'What are your primary security concerns?',
            answer: 'Break-in during evening services.\nUnsecured side entrances.', position: 2 },
          { question: 'How did you hear about us?', answer: 'Referred by Merit Dallas', position: 3 },
          { question: 'Unanswered question', answer: '', position: 4 },
          // Whoever books the call types these, so an answer is text, never markup.
          { question: 'Anything else?', answer: '<img src=x onerror=alert(1)> [see](javascript:alert(1)) Costs $& more', position: 5 },
        ],
      }] });
    }
    return json({ resource: {
      uri: EVENT, name: 'NPSA 30 Minute Introduction Zoom Call',
      start_time: '2026-08-12T16:00:00Z', end_time: '2026-08-12T16:30:00Z', status: 'active',
      location: { actual_instance: { type: 'zoom', join_url: 'https://us02web.zoom.us/j/86249830965?pwd=Fesx',
        data: { id: { actual_instance: 86249830965 }, password: '**********' } } },
      event_guests: [{ email: 'kevin@meritdallas.com' }, { email: 'raj@meritdallas.com' }],
      event_memberships: [{ user_email: 'jeff@nonprofitsecurityadvisors.com', user_name: 'Jeff Markely',
                            user: 'https://api.calendly.com/users/jeff' }],
    } });
  }

  // Nothing should reach the real API: ANTHROPIC_BASE_URL points at the stand-in.
  if (u.includes('api.anthropic.com')) {
    globalThis.__REAL_API_HIT = true;
    return new Response('{}', { status: 500 });
  }

  // Both readers down — the exact condition that emptied a whole briefing in
  // production, where the website, overview, campus list, state, administering
  // agency and deadlines all came back TBD for an organisation whose website was
  // sitting in the invitee's own email address.
  if (globalThis.__READERS_DOWN) {
    if (u.includes('jina.ai')) return new Response('rate limited', { status: 429 });
    if (u.includes('greenlandhills.org')) return new Response('nope', { status: 503 });
  }
  if (u.includes('jina.ai')) return new Response('Kevin Tran, Facilities Director. '.repeat(30), { status: 200 });
  if (u.includes('greenlandhills.org')) return new Response('<html><body><h1>Greenland Hills UMC</h1><p>2828 Wesley St, Dallas, TX 75206. Kevin Tran, Facilities Director.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return realFetch(url, init);
};

// Stand-in Claude Messages API, spoken to over real HTTP. Every request is kept
// so the checks below can look at what the server actually sent.
const claudeCalls = [];
const http = await import('node:http');
await new Promise((resolve) => {
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      claudeCalls.push({ url: req.url, headers: req.headers, body: parsed });
      if (req.url !== '/v1/messages' || !req.headers['x-api-key'] || !parsed.max_tokens) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }));
      }
      // The server asks for bare JSON in its system prompt; Claude has no JSON
      // mode, so the stand-in answers in a code fence with a lead-in sentence to
      // prove the extraction copes with the untidy case.
      const isJsonMode = /single JSON object/.test(parsed.system || '');
      const text = isJsonMode
        ? 'Here is the JSON:\n```json\n' + JSON.stringify({ org_state: 'TX', people: [{ email: 'kevin@meritdallas.com', name: 'Kevin Tran', title: 'Facilities Director', evidence: 'Staff page' }] }) + '\n```'
        : MODEL_OUTPUT;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: parsed.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  }).listen(3212, '127.0.0.1', resolve);
});

// The site is fetched only once its name resolves to a public address. There is
// no DNS here, so the stand-in site is given a public address.
const { __test: publicUrl } = await import(new URL('../server/public-url.js', import.meta.url).href);
publicUrl.setLookup(async (host) => (/greenlandhills\.org$/.test(host) ? [{ address: '93.184.215.14', family: 4 }] : []));

await import(new URL('../server/index.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 1500));

const r = await realFetch('http://localhost:3211/api/precall', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
  body: JSON.stringify({ eventUri: EVENT, formData: { orgType: 'church', orgState: '', attendees: [] } }),
});
const d = await r.json();

console.log('HTTP', r.status);
console.log('--- NOTES ---');
console.log(d.notes || d.error);
console.log('--- meta ---', JSON.stringify({ booking: d.booking, deadlinesFromTable: d.deadlinesFromTable }));

const n = d.notes || '';
const checks = {
  'HTTP 200': r.status === 200,
  'submitted phone present': n.includes('2147089835'),
  'invented phone GONE': !n.includes('555-0199'),
  'invented attendee GONE': !n.includes('Imaginary Person'),
  'fake host GONE': !n.includes('Someone Else'),
  'both guests listed': n.includes('kevin@meritdallas.com') && n.includes('raj@meritdallas.com'),
  'researched guest name marked unverified': n.includes('Kevin Tran') && n.includes('unverified'),
  'masked passcode not printed': !n.includes('**********'),
  'zoom id unwrapped': n.includes('86249830965'),
  'wish list has write-in lines': /1\.\s*\\_/.test(n),
  'no token leaked': !/<<[A-Z_]+>>/.test(n),
  'booking echoed back': d.booking?.eventUri === EVENT,
  'NPSA attendee is the real host, not Brad': n.includes('Jeff Markely') && !n.includes('Brad Lynde'),
  'unknown host gets no borrowed title': !n.includes('Managing Partner'),
  // The booking form asks no state question, so this has to come off the website.
  // A blank one previously cost the briefing its SAA, its deadlines and the
  // state's own stackable program all at once.
  'state derived from the site, not the form': n.includes('(PSO)'),
  'SAA name comes from the knowledge base': n.includes('Office of the Governor'),
  'deadline section keyed to the derived state': /TX sub-applicant deadlines/.test(n),
  'award figures survived': n.includes('Up to $200,000'),
  'deadline section present even with no table': /## NSGP Deadlines/.test(n) && /not recorded|confirm with/i.test(n),
  // The stub drops this token and writes its own congregation size instead — the
  // same failure as the invented phone number, and it must lose the same way: the
  // rep asks on the call and writes the answer on the rule.
  'attendee count section survives': /## # Attendees All Campuses/.test(n),
  'attendee count is a rule, not a guess': /## # Attendees All Campuses\s*\n+\\_/.test(n),
  'invented congregation size GONE': !n.includes('About 1,200 members'),
  // Stuart: "we need it to pull the calendly booking answers into the call
  // notes." Rendered by code for the same reason as the phone number — the
  // answer is already known exactly, so a model asked to reproduce it can only
  // come back right or plausibly wrong.
  'booking answers section present': /## What They Told Us When Booking/.test(n),
  'a booking answer is printed verbatim': n.includes('Break-in during evening services.'),
  'a multi-line answer keeps its second line': n.includes('Unsecured side entrances.'),
  'every answered question reaches the page': n.includes('Referred by Merit Dallas'),
  'an unanswered question is not printed': !n.includes('Unanswered question'),
  // The organization, website and phone are already named fields a few lines up,
  // and the state is in the title. Printing them again invites a rep to wonder
  // which copy is right.
  'the already-rendered fields are not repeated': !/Organization Name:/.test(n)
    && (n.match(/2147089835/g) || []).length <= 2,
  // The answer above, as the page renders it: the tag and the link print as
  // text, and a $ in an answer is not read as a replacement pattern.
  'a booking answer cannot carry markup': (() => {
    const html = marked(n);
    return !/<img|<a [^>]*javascript:/i.test(html) && html.includes('&lt;img src=x onerror=alert(1)&gt;')
      && html.includes('[see](javascript:alert(1))') && n.includes('Costs $& more');
  })(),
};
// The Claude requests themselves: the right endpoint, headers and models, the
// master prompt carried in `system`, and thinking switched off for each model.
const briefingCall = claudeCalls.find((c) => /SUBSTITUTION TOKENS/.test(c.body.system || ''));
const jsonCalls = claudeCalls.filter((c) => /single JSON object/.test(c.body.system || ''));
Object.assign(checks, {
  'Claude was called': claudeCalls.length > 0,
  'real Anthropic API never reached': !globalThis.__REAL_API_HIT,
  'every call sends key and API version': claudeCalls.every((c) =>
    c.url === '/v1/messages' && c.headers['x-api-key'] === 'sk-ant-test' && c.headers['anthropic-version'] === '2023-06-01'),
  'no OpenAI-only fields sent': claudeCalls.every((c) => !('response_format' in c.body) && c.body.messages.every((m) => m.role !== 'system')),
  'briefing uses Sonnet with the prompt in system': briefingCall?.body.model === 'claude-sonnet-5-5'
    && briefingCall.body.max_tokens === 4500 && briefingCall.body.thinking?.type === 'between_tools',
  'website research uses Haiku in JSON form': jsonCalls.length > 0 && jsonCalls.every((c) =>
    c.body.model === 'claude-haiku-5-5' && c.body.thinking?.type === 'disabled'),
});

// The Word export converts HTML the browser posts. An image in it must not make
// the server fetch anything; the stand-in on 3212 records every request it gets.
const probesBefore = claudeCalls.filter((c) => c.url.startsWith('/probe')).length;
const dx = await realFetch('http://localhost:3211/api/precall/docx', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
  body: JSON.stringify({ filename: 'Probe', html: '<html><body><p>Before</p><img src="http://127.0.0.1:3212/probe.png"><IMG/src=http://127.0.0.1:3212/probe2.png><p>After</p></body></html>' }),
});
await dx.arrayBuffer();
Object.assign(checks, {
  'docx export still answers with a file': dx.status === 200,
  'docx export fetches no image the HTML names': claudeCalls.filter((c) => c.url.startsWith('/probe')).length === probesBefore,
});

// Now the degraded run: no reader answers at all.
globalThis.__READERS_DOWN = true;
const r2 = await realFetch('http://localhost:3211/api/precall', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
  body: JSON.stringify({ eventUri: EVENT, formData: { orgType: 'church', orgState: '', attendees: [] } }),
});
const d2 = await r2.json();
const n2 = d2.notes || '';
console.log('\n--- DEGRADED RUN (no reader reachable) ---');
console.log(n2.split('\n').filter(l => /Website|Organization Overview|could not/i.test(l)).join('\n'));

Object.assign(checks, {
  'degraded run still succeeds': r2.status === 200,
  'website survives a reader outage': n2.includes('greenlandhills.org'),
  'website is not reported as TBD': !/Website:\*{0,2}\s*TBD/i.test(n2),
  'submitted facts unaffected by the outage': n2.includes('2147089835') && n2.includes('Jeff Markely'),
  'booking answers unaffected by the outage': n2.includes('Break-in during evening services.'),
});

console.log('\n--- assertions ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + '  ' + k);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
