/*
 * Upcoming Calendly bookings, shaped for the pre-call notes generator.
 *
 * The generator used to start from a block of pasted invite text that a language
 * model then re-extracted into fields. That is how a client-submitted phone number
 * became a different phone number in the finished notes: the model was asked to
 * "find" a fact that was already known exactly, and it obliged with something
 * plausible. Reading the booking straight from Calendly removes the guess.
 *
 * Everything returned under `facts` came from Calendly and is authoritative — the
 * invitee typed it, or Calendly assigned it. Nothing here is inferred.
 */

import { calendlyGet, answerMatching } from './marketing.js';
import { KNOWN_BOOKING_QUESTIONS } from './precall-facts.js';

const CAL_API = 'https://api.calendly.com';

// Question text, not question position — see KNOWN_BOOKING_QUESTIONS. These four
// become named fields here; precall-facts.js leaves the same four out of the
// verbatim answer list so nothing prints twice. One definition, so the two halves
// of that arrangement cannot disagree.
const {
  organization: Q_ORGANIZATION,
  phone:        Q_PHONE,
  website:      Q_WEBSITE,
  state:        Q_STATE,
} = KNOWN_BOOKING_QUESTIONS;

/**
 * Calendly's polymorphic fields (location, and the meeting id inside it) arrive
 * unwrapped from the REST API but wrapped in a discriminated-union envelope from
 * some clients — `{ actual_instance: {...}, one_of_schemas: [...] }`. Unwrapping
 * defensively costs nothing; not unwrapping turns a meeting ID into the string
 * "[object Object]" on a rep's briefing.
 */
function unwrap(v) {
  let out = v;
  while (out && typeof out === 'object' && 'actual_instance' in out) out = out.actual_instance;
  return out;
}

/**
 * Calendly reports the conference differently per provider, and the shape for a
 * Zoom link is not the shape for Google Meet or for a phone call. Normalise to
 * one thing the notes can print, and keep the raw type so an in-person or
 * outbound-call booking is not silently described as a video conference.
 */
function readLocation(rawLoc) {
  const loc = unwrap(rawLoc);
  if (!loc || typeof loc !== 'object') return { kind: 'unknown', label: 'TBD' };
  const kind = loc.type || 'unknown';
  const data = loc.data || {};
  const joinUrl = loc.join_url || data.join_url || null;
  const rawId = unwrap(data.id);
  const id = rawId != null && typeof rawId !== 'object' ? String(rawId) : null;
  // Zoom returns the passcode under settings on some plans and at the top level
  // on others; both are the same field to a rep reading it off the page.
  const rawPass = data.password || data.passcode || data.settings?.password || null;
  // Calendly masks the passcode as a row of asterisks on some org-level reads.
  // Printing that verbatim gives the rep a passcode that cannot work; the join_url
  // carries a ?pwd= token anyway, so the link is the usable route.
  const passcode = rawPass && /^\*+$/.test(String(rawPass).trim()) ? null : rawPass;

  if (kind === 'physical' || kind === 'inbound_call' || kind === 'outbound_call') {
    return { kind, label: loc.location || 'TBD', joinUrl: null, meetingId: null, passcode: null };
  }
  return {
    kind,
    label: kind === 'custom' ? (loc.location || 'Video Web Conference') : 'Video Web Conference',
    joinUrl: joinUrl || (typeof loc.location === 'string' && /^https?:/.test(loc.location) ? loc.location : null),
    meetingId: id,
    passcode,
  };
}

/** US state abbreviation, only when the answer plainly is one. Never inferred. */
function readState(qs) {
  const raw = answerMatching(qs, Q_STATE);
  if (!raw) return null;
  const m = /^\s*([A-Za-z]{2})\s*$/.exec(raw);
  return m ? m[1].toUpperCase() : null;
}

/**
 * One booking, flattened. `facts` is the verbatim set — see the note at the top of
 * this file about why that distinction is load-bearing.
 */
/**
 * Every additional attendee on a booking, from all three places Calendly puts them.
 *
 * This is the bug Brad reported: "Tate added a second attendee on the calendly
 * link, but this was not included." An invitee record has no `guests` property at
 * all — guests hang off the EVENT as `event_guests`, and only a multi-invitee event
 * type produces extra invitee records. Reading the invitee alone finds nothing and
 * reports no guests, which is indistinguishable from a booking that had none.
 */
function collectGuests(ev, invitees) {
  const primaryEmail = String(invitees?.[0]?.email || '').toLowerCase();
  const seen = new Set([primaryEmail]);
  const out = [];
  const candidates = [
    ...(ev.event_guests || []).map(g => g?.email),
    ...(invitees?.[0]?.guests || []).map(g => g?.email),   // harmless if absent
    ...(invitees || []).slice(1).map(i => i?.email),
  ];
  for (const email of candidates) {
    if (!email) continue;
    const key = String(email).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

function shapeBooking(ev, invitee, guests) {
  const qs = invitee?.questions_and_answers || [];
  const location = readLocation(ev.location);
  const host = (ev.event_memberships || [])[0] || {};

  return {
    eventUri: ev.uri,
    inviteeUri: invitee?.uri || null,
    eventName: ev.name || null,
    startTime: ev.start_time || null,          // ISO 8601, UTC — render in the client's zone
    endTime: ev.end_time || null,
    status: ev.status || null,
    host: { name: host.user_name || null, email: host.user_email || null },
    facts: {
      orgName: answerMatching(qs, Q_ORGANIZATION),
      orgState: readState(qs),
      websiteUrl: answerMatching(qs, Q_WEBSITE),
      inviteeName: invitee?.name || null,
      inviteeEmail: invitee?.email || null,
      inviteePhone: answerMatching(qs, Q_PHONE) || invitee?.text_reminder_number || null,
      inviteeTimezone: invitee?.timezone || null,
      startTime: ev.start_time || null,
      guests,                                   // additional invitees, emails only
      location,
      // Kept whole so a rep can see anything the form asked that this code does
      // not know how to name. A new question should surface, not vanish.
      questions: qs.map(q => ({
        question: String(q.question || ''),
        answer: Array.isArray(q.answer) ? q.answer.join(', ') : (q.answer || ''),
      })).filter(q => q.answer),
    },
  };
}

/**
 * Upcoming active bookings across the whole organization — every rep, not just the
 * token's owner, since any of them may be prepping the call.
 *
 * `limit` caps the invitee fetches, which are one API call each. Sorted ascending
 * by start time, so the cap drops the furthest-out meetings rather than the next
 * one on the calendar.
 */
/*
 * Which event types are client consultations.
 *
 * The picker used to list every active booking on the org calendar. Most of what
 * is on it is not a client call: the recurring "NPSA - (Stuart & Chad) Availability"
 * holds are `collective` event types with no profile, and Lynde Consulting's older
 * telecom event types are still live. Generating from one produced a briefing
 * hosted by whoever owned the hold, and a follow-up offering that person's personal
 * Calendly page — which is how Stuart's own link reached client-facing notes.
 *
 * Two kinds of event type count, and they have nothing structural in common:
 *
 *   - The Consultants round robin ("30min NPSA Consultation"). Found by rule:
 *     pooling_type round_robin, hung off a Team profile. A new round robin is
 *     picked up without anyone editing this file.
 *
 *   - Brad's own "NPSA 30 Minute Introduction Zoom Call", which is a plain solo
 *     event type on his personal profile. Nothing distinguishes it from the
 *     telecom event types sitting beside it except what it is FOR, so it has to
 *     be named. That is a business fact, not a derivable one.
 *
 * Named by scheduling-URL path rather than by event-type URI: the path is legible
 * to whoever maintains this, and it is what Stuart would paste when adding one.
 * CALENDLY_CONSULT_EVENT_TYPES overrides the list (paths or full URIs, comma
 * separated) without a deploy.
 */
const DEFAULT_CONSULT_PATHS = [
  'npsa-consultation/intro',                        // Consultants round robin
  'brad-15/npsa-30-minute-introduction-zoom-call',  // Brad's intro call
];

const pathOf = (url) => String(url || '').replace(/^https?:\/\/calendly\.com\//i, '').replace(/\/+$/, '');

let _consults = null;

export async function consultationEventTypes() {
  if (_consults) return _consults;

  const named = (process.env.CALENDLY_CONSULT_EVENT_TYPES || DEFAULT_CONSULT_PATHS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  const me = await calendlyGet('/users/me');
  const org = me.resource.current_organization;
  const all = [];
  let next = `${CAL_API}/event_types?organization=${encodeURIComponent(org)}&active=true&count=100`;
  while (next) {
    const page = await calendlyGet(next);
    all.push(...(page.collection || []));
    next = page.pagination?.next_page || null;
  }

  const isNamed = (t) => named.includes(t.uri) || named.includes(pathOf(t.scheduling_url));
  const isTeamRoundRobin = (t) => t.pooling_type === 'round_robin' && t.profile?.type === 'Team';

  _consults = all.filter(t => isNamed(t) || isTeamRoundRobin(t)).map(t => ({
    uri: t.uri,
    name: t.name,
    schedulingUrl: t.scheduling_url || null,
    roundRobin: isTeamRoundRobin(t),
  }));

  const missing = named.filter(n => !_consults.some(c => c.uri === n || pathOf(c.schedulingUrl) === n));
  if (missing.length) {
    // A named event type that no longer resolves silently stops appearing in the
    // picker, and the rep just sees fewer meetings than they booked.
    console.error('[precall-bookings] consultation event type(s) not found:', missing.join(', '));
  }
  if (!_consults.length) {
    console.error('[precall-bookings] no consultation event types matched — ' +
      'set CALENDLY_CONSULT_EVENT_TYPES, or the picker will be empty');
  }
  return _consults;
}

/**
 * The link a follow-up should offer.
 *
 * The team round robin, never an individual's page — a personal link books that
 * one person and skips the rotation. Still the round robin for a call that came
 * in through Brad's own intro link: the follow-up is an invitation to book NPSA,
 * and the team is what the client should land on.
 */
export async function roundRobinSchedulingUrl() {
  try {
    const types = await consultationEventTypes();
    return types.find(t => t.roundRobin)?.schedulingUrl || null;
  } catch (e) {
    console.error('[precall-bookings] round-robin lookup failed:', e.message);
    return null;
  }
}

export async function listUpcomingBookings({ limit = 40, eventType = null, allEventTypes = false } = {}) {
  const me = await calendlyGet('/users/me');
  const org = me.resource.current_organization;

  const events = [];
  let next = `${CAL_API}/scheduled_events?organization=${encodeURIComponent(org)}`
    + `&status=active&min_start_time=${encodeURIComponent(new Date().toISOString())}`
    + '&count=100&sort=start_time:asc';
  while (next && events.length < limit * 3) {
    const page = await calendlyGet(next);
    events.push(...(page.collection || []));
    next = page.pagination?.next_page || null;
  }

  // Calendly's list-events endpoint accepts an event_type parameter and silently
  // ignores it, so a request that looks filtered comes back unfiltered. Filter here.
  let wanted = events;
  if (eventType) {
    wanted = events.filter(e => e.event_type === eventType);
  } else if (!allEventTypes) {
    // Client consultations only. Without this the picker lists internal holds.
    const ok = (await consultationEventTypes()).map(t => t.uri);
    if (ok.length) wanted = events.filter(e => ok.includes(e.event_type));
  }
  wanted = wanted.slice(0, limit);

  const settled = await Promise.allSettled(wanted.map(async (ev) => {
    const invitees = (await calendlyGet(`${ev.uri}/invitees`)).collection || [];
    if (!invitees[0]) return null;
    return shapeBooking(ev, invitees[0], collectGuests(ev, invitees));
  }));

  const bookings = [];
  for (const [i, r] of settled.entries()) {
    // A booking with no invitee has no contact and nothing to prepare for.
    if (r.status === 'fulfilled') { if (r.value) bookings.push(r.value); }
    else console.error('[precall-bookings]', wanted[i]?.uri, r.reason?.message);
  }
  return bookings;
}

/** Re-read one booking at generation time, so a reschedule since the list loaded is caught. */
export async function getBooking(eventUri) {
  if (!eventUri || !eventUri.startsWith(`${CAL_API}/scheduled_events/`)) {
    throw new Error('eventUri must be a Calendly scheduled_events URI');
  }
  const ev = (await calendlyGet(eventUri)).resource;
  const invitees = (await calendlyGet(`${eventUri}/invitees`)).collection || [];
  const booking = shapeBooking(ev, invitees[0], collectGuests(ev, invitees));

  /*
   * The link a follow-up offers is the team round robin, not the host's own page.
   *
   * This used to read the host user's personal scheduling_url so the email offered
   * the rep who ran the call. That is the right instinct and the wrong field: a
   * personal page books that one person, bypassing the rotation the team actually
   * runs on, and on an internal hold the "host" is whoever owns the hold — which
   * is how Stuart's own Calendly link ended up in client-facing notes.
   *
   * The host's name and email still come from the booking, so the briefing still
   * names the rep who is taking the call. Only the booking link changed.
   */
  booking.host.schedulingUrl = await roundRobinSchedulingUrl();
  return booking;
}

export const __test = { readLocation, readState, shapeBooking };
