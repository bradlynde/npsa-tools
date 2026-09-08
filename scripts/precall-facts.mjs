#!/usr/bin/env node
/*
 * Facts check for the pre-call briefing.
 *
 * Drives the real /api/precall handler with Calendly and OpenAI replaced by local
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
process.env.OPENAI_API_KEY = 'sk-test';
process.env.CALENDLY_API_TOKEN = 'cal-test';
// The OpenAI SDK binds fetch inside its own module, so a globalThis stub never
// sees its requests. Point it at a local stand-in instead.
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:3212/v1';

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

  if (u.includes('api.openai.com')) {
    const body = JSON.parse(init?.body || '{}');
    const isJsonMode = body.response_format?.type === 'json_object';
    const content = isJsonMode
      ? JSON.stringify({ people: [{ email: 'kevin@meritdallas.com', name: 'Kevin Tran', title: 'Facilities Director', evidence: 'Staff page' }] })
      : MODEL_OUTPUT;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
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

// Stand-in OpenAI, spoken to over real HTTP.
const http = await import('node:http');
await new Promise((resolve) => {
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const isJsonMode = parsed.response_format?.type === 'json_object';
      const content = isJsonMode
        ? JSON.stringify({ org_state: 'TX', people: [{ email: 'kevin@meritdallas.com', name: 'Kevin Tran', title: 'Facilities Director', evidence: 'Staff page' }] })
        : MODEL_OUTPUT;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  }).listen(3212, '127.0.0.1', resolve);
});

await import(new URL('../server/index.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 1500));

const r = await realFetch('http://localhost:3211/api/precall', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
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
};
// Now the degraded run: no reader answers at all.
globalThis.__READERS_DOWN = true;
const r2 = await realFetch('http://localhost:3211/api/precall', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
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
});

console.log('\n--- assertions ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + '  ' + k);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
