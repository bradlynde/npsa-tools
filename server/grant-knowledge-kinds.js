// Grant knowledge: what a record can be, and what each kind may hold.
//
// A record is one fact-bearing thing about one jurisdiction: the jurisdiction
// itself, a program, a requirement of a program, a funding cycle, a deadline in a
// cycle, a contact, a note, a source. The shape of each kind's `data` lives here
// as a zod schema, and the schema is strict on purpose: a write that misspells a
// field is refused by name rather than landing somewhere nothing reads. Facts that
// genuinely have no field go in `extra`; a remark about one field's value goes in
// `field_notes[<field>]`.

import { z } from 'zod';

// ── Jurisdictions ─────────────────────────────────────────────────────────────

// 50 states, DC, the five territories with an NSGP allocation, and US for what is
// true nationally (the federal program, its cycles, the IJ form rules).
export const JURISDICTIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
  US: 'Federal (United States)',
};
const TERRITORIES = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);
export const JURISDICTION_CODES = Object.keys(JURISDICTIONS);

export function jurisdictionKind(code) {
  if (code === 'US') return 'federal';
  if (code === 'DC') return 'district';
  return TERRITORIES.has(code) ? 'territory' : 'state';
}

// ── Kinds and where each may hang ─────────────────────────────────────────────

export const KINDS = ['jurisdiction', 'program', 'requirement', 'cycle', 'deadline', 'contact', 'note', 'source'];

// The kinds a record's parent may be. null = may stand alone under the jurisdiction.
export const PARENT_KINDS = {
  jurisdiction: [null],
  program: [null],
  requirement: ['program'],
  cycle: ['program'],
  deadline: ['cycle'],
  contact: [null, 'program'],
  note: [null, 'program'],
  source: [null, 'program'],
};

export const PHASES = ['before_nofo', 'registration', 'application', 'submission', 'post_award'];
export const NOTE_CATEGORIES = ['gotcha', 'eligibility', 'scoring', 'prohibited_cost', 'post_award', 'watch_item', 'history', 'process', 'open_question'];
export const SEVERITIES = ['info', 'caution', 'critical', 'auto_disqualifier'];

// ── Field helpers ─────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const short = (max = 300) => z.string().trim().max(max);
const prose = z.string().max(20000);
const date = z.string().regex(ISO_DATE, 'must be an ISO date, YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'is not a real date');
const money = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const url = z.string().trim().max(1000).regex(/^https?:\/\/\S+$/i, 'must be an http(s) URL');
const email = z.string().trim().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address');

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const timeZone = z.string().trim().max(60).refine(validTimeZone, 'must be an IANA time zone such as America/Chicago');

// Every kind may carry these two.
const common = {
  extra: z.record(z.any()).optional(),
  field_notes: z.record(short(1000)).optional(),
};

const kind = shape => z.object({ ...shape, ...common }).strict();

export const SCHEMAS = {
  jurisdiction: kind({
    name: short(80).optional(),
    saa: short().optional(),
    saa_short: short(60).optional(),
    saa_url: url.optional(),
    participates_federal_nsgp: z.boolean().optional(),
    urban_areas: z.array(short(120)).max(20).optional(),
    partner: short(500).optional(),
    cycle_status: short(200).optional(),
    cycle_timing_note: prose.optional(),
    post_award_note: prose.optional(),
    default_tz: timeZone.optional(),
    summary_md: prose.optional(),
    // US only: the form every applicant fills, and how to handle it.
    ij_form: z.object({
      number: short(60).optional(), revision: short(60).optional(),
      omb_control: short(60).optional(), version_warning: short(2000).optional(),
    }).strict().optional(),
    authoritative_page: url.optional(),
  }),

  program: kind({
    name: short(200),
    type: z.enum(['federal', 'state']),
    administered_by: short().optional(),
    status: z.enum(['active', 'dormant', 'unconfirmed', 'dead']).optional(),
    availability_note: short(2000).optional(),
    locations_max: count.optional(),
    cap_per_location: money.optional(),
    cap_per_applicant: money.optional(),
    ma_pct: z.number().min(0).max(100).optional(),
    cost_match: short(500).optional(),
    pop_months: count.optional(),
    pop_note: short(1000).optional(),
    window_days: count.optional(),
    deadline_authority: short(500).optional(),
    stackable: z.union([z.boolean(), z.literal('verify')]).optional(),
    exclusive_with: z.array(short(80)).max(10).optional(),
    inherits_from: short(80).optional(),
    submission: z.object({
      method: short(60).optional(), target: short(500).optional(), url: url.optional(),
      platform: short(120).optional(), package_note: prose.optional(),
    }).strict().optional(),
    file_naming: prose.optional(),
    eligible_costs: prose.optional(),
    notes_md: prose.optional(),
  }),

  requirement: kind({
    req_type: z.enum(['registration', 'document']),
    label: short(),
    owner: z.enum(['client', 'npsa']).optional(),
    lead_time_days: count.optional(),
    hard_gate: z.boolean().optional(),
    format: short(200).optional(),
    notes: prose.optional(),
    phase: z.enum(PHASES).optional(),
    url: url.optional(),
    // What the client sees on their intake page, when it differs from `label`.
    client_label: short().optional(),
    client_hint: prose.optional(),
    // A registration step's "How to do this" box on the client's checklist: what to have ready,
    // then the steps in order. A step may open with a **bold lead**.
    client_ready: z.array(short(300)).max(8).optional(),
    client_steps: z.array(short(500)).max(12).optional(),
    upload_key: z.string().regex(/^up_[a-z0-9_]{2,40}$/).optional(),
    task_stem: short(80).optional(),
    ready_label: short().optional(),
  }),

  cycle: kind({
    fiscal_year: z.number().int().min(2000).max(2100),
    label: short(80).optional(),
    status: z.enum(['pre_nofo', 'open', 'closed', 'awaiting_awards', 'awarded']).optional(),
    nofo_date: date.optional(),
    open_date: date.optional(),
    pop_start: date.optional(),
    pop_end: date.optional(),
    total_funding: money.optional(),
    nsgp_s_funding: money.optional(),
    nsgp_ua_funding: money.optional(),
    state_allocation: money.optional(),
    ua_allocations: z.record(money).optional(),
    applications: count.optional(),
    awards: count.optional(),
    award_total: money.optional(),
    confidence: z.enum(['confirmed', 'illustrative', 'projected']).optional(),
    notes: prose.optional(),
  }),

  deadline: kind({
    label: short(200),
    stage_order: count.optional(),
    due_date: date,
    due_time: z.string().regex(HHMM, 'must be HH:MM, 24-hour').optional(),
    tz: timeZone.optional(),
    deadline_kind: z.enum(['sub_applicant', 'noi', 'registration', 'stage', 'questions', 'fema', 'state_program']).optional(),
    binding: z.boolean().optional(),
    confidence: z.enum(['confirmed', 'illustrative', 'projected']).optional(),
    note: prose.optional(),
  }),

  contact: kind({
    name: short(120).optional(),
    role: short(200).optional(),
    org: short(200).optional(),
    email: email.optional(),
    phone: short(60).optional(),
    contact_kind: z.enum(['saa', 'program', 'cisa_psa', 'partner', 'helpdesk', 'other']).optional(),
    area: short(200).optional(),
    is_primary: z.boolean().optional(),
    last_confirmed: date.optional(),
    warning: short(1000).optional(),
    notes: prose.optional(),
  }).refine(c => c.name || c.role || c.org || c.email || c.phone, 'a contact needs at least a name, role, org, email or phone'),

  note: kind({
    category: z.enum(NOTE_CATEGORIES),
    severity: z.enum(SEVERITIES).optional(),
    title: short(200),
    body_md: prose.optional(),
    phase: z.enum(PHASES).optional(),
    client_slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80).optional(),
    observed_on: date.optional(),
    resolved: z.boolean().optional(),
    resolved_at: date.optional(),
  }),

  source: kind({
    url: url,
    title: short().optional(),
    publisher: short(200).optional(),
    accessed: date.optional(),
    covers: short(500).optional(),
  }),
};

/** Validates one kind's data. Returns the parsed object or throws an Error naming every bad field. */
export function parseData(kindName, data) {
  const schema = SCHEMAS[kindName];
  if (!schema) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const problems = r.error.issues.map(i => {
    if (i.code === 'unrecognized_keys') return `unknown field(s) ${i.keys.join(', ')} (use "extra" for facts with no field)`;
    return `${i.path.join('.') || 'data'}: ${i.message}`;
  });
  throw new Error(`${kindName}: ${problems.join('; ')}`);
}

// ── Derived columns ───────────────────────────────────────────────────────────

/** What a person would call this record: the line a search hit or a history row shows. */
export function titleFor(kindName, key, data = {}) {
  switch (kindName) {
    case 'jurisdiction': return data.name || JURISDICTIONS[key] || key;
    case 'program': return data.name || key;
    case 'requirement': return data.label || key;
    case 'cycle': return data.label || (data.fiscal_year ? `FY${data.fiscal_year}` : key);
    case 'deadline': return data.label || key;
    case 'contact': return data.name || data.role || data.org || data.email || key;
    case 'note': return data.title || key;
    case 'source': return data.title || data.url || key;
    default: return key;
  }
}

function collectStrings(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (Array.isArray(v)) v.forEach(x => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => collectStrings(x, out));
}

/** Lowercased haystack for search: the key plus every string and number in the data. */
export function searchTextFor(kindName, key, data = {}) {
  const out = [key];
  collectStrings(data, out);
  return out.join(' \n ').toLowerCase().slice(0, 40000);
}

/** The one date worth an index: when a deadline falls, when a cycle opens. */
export function sortDateFor(kindName, data = {}) {
  if (kindName === 'deadline') return data.due_date || null;
  if (kindName === 'cycle') return data.open_date || data.nofo_date || null;
  return null;
}

/** A natural key for kinds that have no obvious one: a slug of the title. */
export function slugKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'item';
}
