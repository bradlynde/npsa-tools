/*
 * The parts of the pre-call briefing that a language model is not allowed to write.
 *
 * The City Church notes printed a contact phone of (260) 415-4783. The number the
 * client typed into Calendly was 260-602-2317. Nothing was broken in the sense of
 * throwing an error — the model was handed the booking as prose, asked to pull the
 * phone number out, and produced a well-formatted number that was not the one it
 * had been given. A rep reading those notes would have dialled a stranger.
 *
 * So the division here is by what a model is good at. Research — reading a church's
 * website and working out that a name belongs to the facilities director — is a
 * genuine strength. Transcription is not: asking it to copy a value that is already
 * known exactly is all downside, because the only possible outcomes are "correct"
 * and "plausibly wrong", and plausibly wrong is invisible.
 *
 * Anything the client submitted through Calendly is therefore rendered here, by
 * code, straight from the booking. The model emits a token and never sees the job.
 * Anything researched is labelled as researched, so the rep can tell the difference
 * at a glance rather than having to trust the whole document equally.
 */

/*
 * Who is actually running the call.
 *
 * This was hard-coded to Brad, so a briefing for one of Jeff's or Chad's meetings
 * put Brad's name and address in the attendee list. The Meeting Details block had
 * the host right — it reads the booking — which made the two halves of the same
 * document disagree with each other.
 *
 * Titles are only listed for the people whose titles are known. An unknown one
 * prints the name and address alone rather than borrowing Brad's, which is the
 * same rule the rest of this file follows: no value beats an invented one.
 */
export const NPSA_TITLES = {
  'brad@lyndeconsulting.com': 'Managing Partner, NPSA',
};
const DEFAULT_HOST = { name: 'Brad Lynde', email: 'brad@lyndeconsulting.com' };

function hostLine(host) {
  const h = host?.name || host?.email ? host : DEFAULT_HOST;
  const title = NPSA_TITLES[String(h.email || '').toLowerCase()];
  return [`**${esc(h.name || h.email)}**`, title, esc(h.email || '')]
    .filter(Boolean).join(' · ');
}

/** Escapes the pipe and underscore markdown would otherwise eat inside a value. */
const esc = (s) => String(s == null ? '' : s).replace(/([|_*`])/g, '\\$1');

/**
 * Central time, with the abbreviation the date actually falls in.
 *
 * The old rule was "always show CST". Half the selling year is CDT, and a July
 * meeting labelled CST is an hour wrong to anyone who reads the label literally —
 * which is the sort of error that only shows up as a missed call. The time shown is
 * unchanged; the label is now honest about which it is.
 */
export function formatCentral(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d).replace(' at ', ' · ');
}

/** The same instant in the client's own zone — only worth printing when it differs. */
function formatInvitee(iso, tz) {
  const d = new Date(iso);
  if (!iso || !tz || Number.isNaN(d.getTime())) return null;
  try {
    const central = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(d);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
    return local.startsWith(central) ? null : local;
  } catch { return null; }   // an unrecognised IANA zone is not worth failing over
}

const WEBSITE_LABEL = { school: 'School Website', church: 'Church Website' };

export function buildMeetingDetails(facts, { orgType, website, hostName } = {}) {
  const when = formatCentral(facts.startTime);
  const theirs = formatInvitee(facts.startTime, facts.inviteeTimezone);
  const loc = facts.location || {};
  const rows = [
    ['Date & Time', when ? (theirs ? `${when}  (${theirs} for the client)` : when) : 'TBD'],
    ['Host', hostName || DEFAULT_HOST.name],
    ['Location', loc.label || 'TBD'],
    ['Organization', facts.orgName || 'TBD'],
    [WEBSITE_LABEL[orgType] || 'Website', website || 'TBD'],
    // The field this whole module exists for.
    ['Contact Phone', facts.inviteePhone || 'not provided on the booking'],
  ];
  return rows.map(([k, v]) => `- **${k}:** ${esc(v)}`).join('\n');
}

/**
 * `research` maps a lowercased email to { name, title, evidence } worked out from
 * the website. It is always rendered as research — never merged silently into the
 * submitted facts — so the rep can see which half of a line came from where.
 */
export function buildAttendees(facts, research = {}, host = null) {
  const find = (email) => research[String(email || '').toLowerCase()] || null;
  const out = [];

  out.push(`**${esc(facts.orgName || 'Client')}**`);

  const r = find(facts.inviteeEmail);
  const primaryBits = [
    `**${esc(facts.inviteeName || facts.inviteeEmail || 'Unknown')}**`,
    r?.title ? `${esc(r.title)} *(unverified — from website)*` : '_title not verified_',
    esc(facts.inviteeEmail || ''),
    esc(facts.inviteePhone || ''),
  ].filter(Boolean);
  out.push(`- ${primaryBits.join(' · ')}`);

  // Brad: "Tate added a second attendee on the calendly link, but this was not
  // included." Guests come off the booking, so they cannot be missed again; who
  // they are is research, and is labelled as such.
  for (const email of (facts.guests || [])) {
    const g = find(email);
    const bits = [
      g?.name ? `**${esc(g.name)}** *(unverified)*` : `**${esc(email)}**`,
      g?.title ? `${esc(g.title)} *(unverified — from website)*` : '_identity not verified from the website_',
      g?.name ? esc(email) : null,
      'added as an additional guest on the booking',
    ].filter(Boolean);
    out.push(`- ${bits.join(' · ')}`);
  }

  out.push('');
  out.push('**NPSA**');
  out.push(`- ${hostLine(host)}`);
  return out.join('\n');
}

export function buildVideoConference(location = {}) {
  if (location.kind === 'physical') return `- **In person:** ${esc(location.label || 'TBD')}`;
  if (location.kind === 'inbound_call' || location.kind === 'outbound_call') {
    return `- **Phone call:** ${esc(location.label || 'TBD')}`;
  }
  return [
    ['Link', location.joinUrl],
    ['Meeting ID', location.meetingId],
    ['Passcode', location.passcode],
  ].map(([k, v]) => `- **${k}:** ${v ? esc(v) : 'TBD'}`).join('\n');
}

/** Ruled write-in lines. An empty numbered list renders as nothing at all in Word. */
export function writeInLines(n = 3) {
  const rule = '\\_'.repeat(48);
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${rule}`).join('\n\n');
}

/**
 * Swaps the tokens for their rendered blocks.
 *
 * A model that drops a token would silently drop a whole section of facts, so a
 * missing token is repaired rather than ignored: the block is appended under its
 * heading if the heading is there, and at the end if it is not. Losing the contact
 * phone quietly is exactly the failure this file exists to prevent.
 */
export function substituteBlocks(markdown, blocks) {
  let md = String(markdown || '');
  for (const [token, { heading, body }] of Object.entries(blocks)) {
    const tag = `<<${token}>>`;
    if (md.includes(tag)) { md = md.split(tag).join(body); continue; }

    // The section is REPLACED, not prepended to. A model that drops the token has
    // usually written its own version of the content, and that version is the
    // fabrication being guarded against — leaving it in place next to the real
    // values would print two contact phone numbers and let the rep pick.
    // The stop condition is "next ## heading, or the true end of the string".
    // `$` cannot express that here: under the m flag it matches at every line
    // ending, so a lazy match paired with it stops at the first newline and leaves
    // the rest of the section — including the invented values — in place.
    const sectionRe = new RegExp(
      `(^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)[\\s\\S]*?(?=^##\\s|(?![\\s\\S]))`, 'mi');
    if (sectionRe.test(md)) md = md.replace(sectionRe, `$1\n\n${body}\n\n`);
    else md += `\n\n## ${heading}\n\n${body}\n`;
  }
  // Any token the caller did not supply must not reach the rep as literal angle
  // brackets — that reads as a broken document rather than a missing section.
  return md.replace(/<<[A-Z_]+>>/g, '').replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Gives a heading with nothing under it something to hold. Brad's copy showed
 * "Top Three Security Wish List Items" as a bare heading, because three empty list
 * markers survive markdown but disappear in Word.
 */
export function fillEmptySections(markdown, headings, filler) {
  let md = String(markdown || '');
  for (const h of headings) {
    // Same stop condition as substituteBlocks, and for the same reason: a `$` here
    // would end the body at the first newline and call every section empty.
    const re = new RegExp(
      `(^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi');
    md = md.replace(re, (whole, head, body) =>
      body.replace(/[\s\d.]/g, '').length === 0 ? `${head}\n\n${filler}\n\n` : whole);
  }
  return md;
}

export const __test = { esc, formatInvitee, hostLine, DEFAULT_HOST, NPSA_TITLES };
