#!/usr/bin/env node
/*
 * Which Calendly bookings the pre-call generator is allowed to see.
 *
 * Stuart: "Stuart's own Calendly link is appearing in generated notes. this
 * should only be pulling the consultants round robin" — plus Brad's own intro
 * call, which is a client consultation too.
 *
 * The picker was listing every active booking on the org calendar. Read against
 * the live account, four of nine upcoming meetings were internal availability
 * holds. Generating from one produced a briefing hosted by whoever owned the
 * hold and a follow-up offering that person's personal Calendly page.
 *
 * Fixtures below are trimmed from the real API responses, including the two
 * shapes that matter: a `collective` event type with `profile: null` (the
 * internal hold) and a `round_robin` one on a Team profile (the consultation).
 *
 *   node scripts/precall-bookings.mjs
 */

import { calendlyGet as _real } from '../server/marketing.js';

const EVENT_TYPES = [
  { uri: 'https://api.calendly.com/event_types/9e2504de', name: '30min NPSA Consultation',
    pooling_type: 'round_robin', profile: { type: 'Team', name: 'Consultants' },
    scheduling_url: 'https://calendly.com/npsa-consultation/intro' },
  { uri: 'https://api.calendly.com/event_types/c17a1ecd', name: 'NPSA 30 Minute Introduction Zoom Call',
    pooling_type: null, profile: { type: 'User', name: 'Brad Lynde' },
    scheduling_url: 'https://calendly.com/brad-15/npsa-30-minute-introduction-zoom-call' },
  // Brad's older telecom event type — same shape as the one above, different purpose.
  { uri: 'https://api.calendly.com/event_types/AFGTMVHB', name: '20 Minute Introduction Zoom Conversation',
    pooling_type: null, profile: { type: 'User', name: 'Brad Lynde' },
    scheduling_url: 'https://calendly.com/brad-15/20-minute-introduction-zoom-conversation' },
  { uri: 'https://api.calendly.com/event_types/7cd2606c', name: '30 Minute Meeting',
    pooling_type: null, profile: { type: 'User', name: 'Stuart Reese' },
    scheduling_url: 'https://calendly.com/stuart-nonprofitsecurityadvisors/30min' },
];

// The internal hold. profile is null, which is why it never appears in the org's
// event-type listing — so it can only be excluded by not being on the list.
const HOLD_TYPE = 'https://api.calendly.com/event_types/1ee8dc2f';

const ev = (uri, name, eventType, hostName, hostEmail) => ({
  uri, name, status: 'active', start_time: '2026-08-20T18:00:00Z', end_time: '2026-08-20T18:30:00Z',
  event_type: eventType, location: { type: 'zoom', join_url: 'https://us02web.zoom.us/j/1' },
  event_memberships: [{ user: `https://api.calendly.com/users/${hostName}`, user_name: hostName, user_email: hostEmail }],
  event_guests: [],
});

const EVENTS = [
  ev('https://api.calendly.com/scheduled_events/e1', 'NPSA - (Stuart & Chad) Availability', HOLD_TYPE, 'Stuart Reese', 'stuart@nonprofitsecurityadvisors.com'),
  ev('https://api.calendly.com/scheduled_events/e2', '30min NPSA Consultation', EVENT_TYPES[0].uri, 'Chad Burgess', 'chad@nonprofitsecurityadvisors.com'),
  ev('https://api.calendly.com/scheduled_events/e3', 'NPSA 30 Minute Introduction Zoom Call', EVENT_TYPES[1].uri, 'Brad Lynde', 'brad@lyndeconsulting.com'),
  ev('https://api.calendly.com/scheduled_events/e4', '20 Minute Introduction Zoom Conversation', EVENT_TYPES[2].uri, 'Brad Lynde', 'brad@lyndeconsulting.com'),
  ev('https://api.calendly.com/scheduled_events/e5', 'NPSA - (Stuart & Jeff) Availability', HOLD_TYPE, 'Stuart Reese', 'stuart@nonprofitsecurityadvisors.com'),
];

const INVITEE = {
  uri: 'https://api.calendly.com/invitees/i1', name: 'Geoffrey Moore',
  email: 'geoffrey@greenlandhills.org', timezone: 'America/Chicago',
  questions_and_answers: [{ question: 'Organization Name', answer: 'Greenland Hills UMC' }],
};

let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/users/me')) return json({ resource: { current_organization: 'https://api.calendly.com/organizations/ORG' } });
  if (u.includes('/event_types?')) return json({ collection: EVENT_TYPES, pagination: { next_page: null } });
  if (u.includes('/scheduled_events?')) return json({ collection: EVENTS, pagination: { next_page: null } });
  if (/\/scheduled_events\/[^/]+\/invitees/.test(u)) return json({ collection: [INVITEE], pagination: { next_page: null } });
  if (/\/scheduled_events\/[^/]+$/.test(u)) return json({ resource: EVENTS.find(e => u.endsWith(e.uri.split('/').pop())) || EVENTS[1] });
  if (/\/users\/[^/?]+$/.test(u)) throw new Error('a personal user page must not be fetched for a scheduling link');
  return json({});
};

process.env.CALENDLY_API_TOKEN ||= 'test';
delete process.env.CALENDLY_CONSULT_EVENT_TYPES;

const { listUpcomingBookings, getBooking, consultationEventTypes, roundRobinSchedulingUrl } =
  await import('../server/precall-bookings.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

const types = await consultationEventTypes();
const names = types.map(t => t.name).sort();
check('the consultants round robin is included', names.includes('30min NPSA Consultation'));
check("Brad's intro call is included", names.includes('NPSA 30 Minute Introduction Zoom Call'));
check('the telecom event type beside it is not',
  !names.includes('20 Minute Introduction Zoom Conversation'), names.join(' | '));
check("a personal 30 Minute Meeting is not", !names.includes('30 Minute Meeting'));

const bookings = await listUpcomingBookings({ limit: 40 });
const listed = bookings.map(b => b.eventName);
check('internal availability holds are gone from the picker',
  !listed.some(n => /Availability/i.test(n)), listed.join(' | '));
check('both kinds of client consultation survive',
  listed.includes('30min NPSA Consultation') && listed.includes('NPSA 30 Minute Introduction Zoom Call'),
  listed.join(' | '));
check('and nothing else does', listed.length === 2, listed.join(' | '));

// The link. A personal page books one person and skips the rotation; the stub
// throws if the personal user record is fetched at all.
const url = await roundRobinSchedulingUrl();
check('the follow-up link is the consultants round robin',
  url === 'https://calendly.com/npsa-consultation/intro', String(url));

const booked = await getBooking('https://api.calendly.com/scheduled_events/e2');
check('a booking carries the round-robin link, not the host\'s page',
  booked.host.schedulingUrl === 'https://calendly.com/npsa-consultation/intro', String(booked.host.schedulingUrl));
check('the host is still named, so the briefing credits the right rep',
  booked.host.name === 'Chad Burgess' && booked.host.email === 'chad@nonprofitsecurityadvisors.com',
  JSON.stringify(booked.host));

// A call booked through Brad's own link still points the client at the team.
const bradsCall = await getBooking('https://api.calendly.com/scheduled_events/e3');
check("a call booked on Brad's link still offers the team link",
  bradsCall.host.schedulingUrl === 'https://calendly.com/npsa-consultation/intro');

const before = calls;
await consultationEventTypes();
check('the event-type lookup is cached, not refetched per request', calls === before);

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
