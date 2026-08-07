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
- **Administered By:** Texas Division of Emergency Management (TDEM)

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

## Top Three Security Wish List Items
<<WISH_LIST>>

## Video Conference Details
<<VIDEO_CONFERENCE>>`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url);

  if (u.startsWith('https://api.calendly.com')) {
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
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
      event_memberships: [{ user_email: 'brad@lyndeconsulting.com', user_name: 'Brad Lynde' }],
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

  if (u.includes('jina.ai')) return new Response('Kevin Tran, Facilities Director. '.repeat(30), { status: 200 });
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
        ? JSON.stringify({ people: [{ email: 'kevin@meritdallas.com', name: 'Kevin Tran', title: 'Facilities Director', evidence: 'Staff page' }] })
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
  body: JSON.stringify({ eventUri: EVENT, formData: { orgType: 'church', orgState: 'TX', attendees: [] } }),
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
  'award figures survived': n.includes('Up to $200,000') && n.includes('TDEM'),
  'deadline section present even with no table': /## NSGP Deadlines/.test(n) && /not recorded|confirm with/i.test(n),
};
console.log('\n--- assertions ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + '  ' + k);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
