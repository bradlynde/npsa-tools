// Proves the sales rep's name gets onto a booking that arrived without one.
//
// bookings.host was written in exactly one place: upsertBooking, from whatever the
// Zap posted at ingest. Nothing ever re-asked, so a delivery that omitted the field
// -- a new round-robin member, a second event type, a mapping that lost the token --
// left that booking blank for ever, and three of the newest bookings on the
// dashboard were showing no rep at all.
//
// The answer was already on the wire. calendlyStatus GETs the scheduled event on
// every enrichment to read its status, and event_memberships sits in that same
// response next to it. This asserts it is read rather than discarded, on every path
// that reached the event, and that a path which never reached it still says null --
// because enrichBooking COALESCEs on that null, and a wrong "no host" would erase a
// name the Zap got right.
//
//   node scripts/booking-host.mjs
//
// TARGET points at an alternate copy of marketing.js, which is how the before/after
// comparison is run. Against the code before this change A-D and G all fail.
//
// No database: this is the parsing half, and it is where the bug was. The write is
// one COALESCE, asserted against the source at the end.
import { readFile } from 'node:fs/promises';

const EVENT = 'https://api.calendly.com/scheduled_events/evt-1';
const HOST = 'jeff@nonprofitsecurityadvisors.com';

// Shapes taken from a real Calendly response. A round robin has one membership; a
// collective lists every host and the first is the owner.
const event = (status, memberships) => ({
  resource: { status, event_memberships: memberships },
});
const ONE = [{ user_email: HOST, user_name: 'Jeff Markely' }];
const TWO = [{ user_email: HOST }, { user_email: 'stuart@nonprofitsecurityadvisors.com' }];

let plan = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  const hit = u.endsWith('/invitees') ? plan.invitees : plan.event;
  if (!hit) return new Response('nope', { status: 404 });
  return new Response(JSON.stringify(hit), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

process.env.CALENDLY_API_TOKEN = 'test-token';
const TARGET = process.env.TARGET
  ? new URL(process.env.TARGET, `file://${process.cwd()}/`)
  : new URL('../server/marketing.js', import.meta.url);
const { calendlyStatus } = await import(TARGET.href);

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// A. THE CASE: an upcoming meeting, the cheap path -- no invitee call at all. This
//    is the shape every one of the three blank rows is in, and before the change it
//    returned nothing but cancelled:false.
plan = { event: event('active', ONE) };
check('A  an upcoming meeting reports its host',
  (await calendlyStatus(EVENT)).host, HOST);

// B. The attendance path takes a second call and a different return. The host has
//    to survive it, or a past meeting silently loses the name it just learned.
plan = { event: event('active', ONE), invitees: { collection: [{ no_show: null }] } };
const past = await calendlyStatus(EVENT, { checkAttendance: true });
check('B  a held meeting keeps the host alongside held', [past.host, past.held], [HOST, true]);

// C. Cancelled events are excluded from the counts but still listed, and the row
//    still shows a rep column. Calendly answered; use the answer.
plan = { event: event('canceled', ONE) };
check('C  a cancelled meeting still reports its host',
  (await calendlyStatus(EVENT)).host, HOST);

// D. A collective event owner is the first membership -- the same choice the
//    Calendly backfill makes, so a booking reads the same host whichever path
//    imported it. Disagreeing here would flip names on re-enrichment.
plan = { event: event('active', TWO) };
check('D  a collective event takes the first membership as owner',
  (await calendlyStatus(EVENT)).host, HOST);

// E. THE ONE THAT MUST BE NULL. Calendly was not reached, so this knows nothing --
//    and enrichBooking COALESCEs, so null is what leaves an existing name alone.
//    Returning '' or undefined here would blank every host on the next sweep.
plan = {};
check('E  an unreachable event reports null, not a blank', (await calendlyStatus(EVENT)).host, null);

plan = { event: event('active', ONE) };
check('E2 no event uri reports null', (await calendlyStatus(null)).host, null);

const noToken = process.env.CALENDLY_API_TOKEN;
delete process.env.CALENDLY_API_TOKEN;
check('E3 no Calendly token reports null', (await calendlyStatus(EVENT)).host, null);
process.env.CALENDLY_API_TOKEN = noToken;

// F. An event with no memberships at all -- Calendly answered, but not this. Same
//    rule as E: null, so the stored name stands.
plan = { event: event('active', []) };
check('F  an event with no memberships reports null',
  (await calendlyStatus(EVENT)).host, null);

// G. The write. Calendly WINS over the stored value here, the opposite of the
//    columns around it, because a round robin can be reassigned and the calendar is
//    the truth -- but COALESCE means null (E, E2, E3, F) still falls through to what
//    is already there.
const src = await readFile(TARGET, 'utf8');
check('G  enrichBooking writes host, COALESCEd so a null cannot blank it',
  /host=COALESCE\(\$\d+, host\)/.test(src), true);

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
