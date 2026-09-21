/**
 * Client for the Sales Toolbox marketing data, via the same-origin proxy at
 * /api/marketing/* (see app/api/marketing/[...path]/route.ts).
 *
 * The upstream endpoints report all-time totals and have no date-range filter,
 * so range-scoped figures (this month, last month, this quarter, YTD) are derived
 * here from the daily time series, which is aggregated server-side and therefore
 * uncapped.
 */

export type Range = 'month' | 'lastmonth' | 'quarter' | 'ytd' | 'all';
export type Granularity = 'week' | 'month';
export type SalesGranularity = 'month' | 'quarter';

export type TimeseriesRow = {
  period: string; // YYYY-MM-DD (Central), start of the day, week or month
  booked: number;
  held: number;
  /** Meetings whose outcome is known. Absent on backends older than Aug 2026. */
  resolved?: number;
  clients: number; // LOEs sent
  won: number;
  won_amount: number | string;
};

export type ChannelRow = {
  channel: string;
  booked: number;
  clients: number;
  fees: number;
};

export type CampaignRow = {
  campaign: string;
  booked: number;
  held: number;
  clients: number;
  fees: number;
};

export type BookingRow = {
  id: number;
  booked_on: string | null;
  /** When a rescheduled appointment was first set: the booked_on of the first
   *  booking in its chain, and null unless this row replaced another. Optional
   *  because the backend only began sending it alongside this change. */
  originated_on?: string | null;
  meeting_date: string | null;
  name: string | null;
  organization: string | null;
  email: string | null;
  told_us: string | null;
  attribution_channel: string | null;
  /** Which rule supplied the campaign — see attributionNote(). */
  attribution_source?: string | null;
  instantly_campaign: string | null;
  /** The campaign's Instantly id. Names drift when a campaign is renamed; an id
   *  does not, so campaignsInRange() groups on this and falls back to the name
   *  only for rows enriched before the column existed. Optional because the
   *  backend only began sending it alongside this change. */
  instantly_campaign_id?: string | null;
  host: string | null;
  held: boolean | null;
  became_client: boolean | null;
  fee: number;
  won: boolean | null;
  won_amount: number;
  /** Set when a booking is deliberately left out of every total. */
  exclusion_reason?: string | null;
  /** Cancelled in Calendly — stated, not offered as a choice. */
  cancelled?: boolean | null;
  /** The booking this one replaced, when the meeting was moved rather than newly made. */
  rescheduled_from?: number | null;
  /** The booking that replaced this one. */
  rescheduled_to?: number | null;
  /** Meeting date on either side of the move, for saying what changed. */
  rescheduled_from_date?: string | null;
  rescheduled_to_date?: string | null;
};

/** The only reasons a booking may be set aside; anything else is rejected upstream. */
export const EXCLUSION_REASONS = ['unqualified', 'double_booking', 'cancelled'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_LABELS: Record<string, string> = {
  unqualified: 'Unqualified',
  double_booking: 'Double booking',
  cancelled: 'Cancelled',
};

/** Channels a booking can be re-attributed to when the automatic guess is wrong. */
export const CHANNEL_CHOICES = [
  'instantly',
  'google_ads',
  'search',
  'email',
  'social',
  'referral',
  'conference',
  'linkedin',
  'past_engaged_prospect',
  'direct',
] as const;

/** Headline numbers, including the Salesforce revenue layer. */
export type Stats = {
  total_bookings: number;
  bookings_this_week: number;
  bookings_this_month: number;
  bookings_last_month: number;
  /** Last month up to the same day of the month. Absent on backends before Sep 2026. */
  bookings_last_month_to_date?: number;
  client_rate: number;
  held_rate: number;
  instantly_pct: number;
  total_fees_won: number;
  won_count: number;
  won_rate: number;
  won_revenue: number;
  won_revenue_total: number;
  won_count_total: number;
  attributed_revenue: number;
  attributed_count: number;
  untracked_revenue: number;
  untracked_count: number;
  attribution_coverage: number;
  /** Distinct organisations won — an org with several grants is still one win. */
  won_org_count?: number;
  /** Bookings deliberately left out of every figure, with the reason. */
  excluded?: { reason: string; label: string; total: number; this_week: number }[];
  excluded_total?: number;
  excluded_this_week?: number;
  /**
   * Signed business the revenue figures leave out because the financial record's
   * Purpose was never set in Salesforce. Zero whenever the data is clean — see
   * UncountedLine for why only a blank Purpose counts as missing.
   */
  revenue_unset_purpose?: { count: number; amount: number };
};

export type UntrackedWin = {
  opportunity_id: string;
  organization: string | null;
  domain: string | null;
  amount: number;
  close_date: string | null;
};

/** Grant applications — the client-side of the business, from Salesforce. */
export type ApplicationStats = {
  total: number;
  awarded_count: number;
  pending_count: number;
  preparing_count: number;
  denied_count: number;
  awarded_amount: number;
  pending_amount: number;
  acceptance_rate: number;
  award_fill_rate: number;
  by_program: {
    grant_program: string;
    total: number;
    awarded_count: number;
    pending_count: number;
    awarded_amount: number;
    pending_amount: number;
  }[];
};

/** One period of won business, for the sales trend. */
export type SalesPoint = {
  period: string;
  contracts: number;
  orgs: number;
  new_orgs: number;
  amount: number;
};

export type SyncRun = {
  source?: string | null;
  ok?: boolean | null;
  started_at?: string | null;
  finished_at?: string | null;
  rows_seen?: number | null;
  error?: string | null;
  note?: string | null;
};

export type SyncStatus = { runs?: SyncRun[]; pull_configured?: boolean };

export type Funnel = {
  booked: number;
  held: number;
  resolved?: number;
  clients: number;
  fees: number;
  won: number;
  won_amount: number;
};

function authHeaders(): Record<string, string> {
  const token = typeof window === 'undefined' ? null : localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/marketing/${path}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`marketing/${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const fetchStats = () => get<Stats>('stats');
export const fetchApplicationStats = () => get<ApplicationStats>('applications/stats');
export const fetchSalesTimeseries = (gran: SalesGranularity = 'month') =>
  get<SalesPoint[]>(`sales-timeseries?granularity=${gran}`);

/** Sync status is best-effort: older backends don't expose it, so a failure is silent. */
export async function fetchSyncStatus(): Promise<SyncStatus | null> {
  try {
    return await get<SyncStatus>('sync/status');
  } catch {
    return null;
  }
}
export const fetchFunnel = () => get<Funnel>('funnel');
export const fetchTimeseries = (gran: Granularity | 'day' = 'week') =>
  get<TimeseriesRow[]>(`timeseries?granularity=${gran}`);
export const fetchChannels = () => get<ChannelRow[]>('by-channel');
export const fetchCampaigns = () => get<CampaignRow[]>('by-campaign');
export const fetchUntrackedWins = () => get<UntrackedWin[]>('untracked-wins');
export const fetchBookings = (search = '') =>
  get<BookingRow[]>(`bookings${search ? `?search=${encodeURIComponent(search)}` : ''}`);

export type BookingPatch = {
  held?: boolean;
  became_client?: boolean;
  /** '' clears the reason and puts the booking back into the totals. */
  exclusion?: string;
  /** '' clears a manual channel override and restores the detected one. */
  channel?: string;
  /**
   * Names the Instantly campaign behind this booking. Settles the channel too, and
   * clears any channel override; '' hands the booking back to automatic detection.
   */
  campaign?: string;
};

/**
 * What somebody needs in order to name the campaign themselves.
 *
 * `suggestions` are campaigns that could account for the booking, with the evidence
 * for each — the same searches automatic detection runs, kept rather than reduced to
 * a single winner. `all` is every campaign, for when none of them fit.
 */
export type CampaignOptions = {
  current: string | null;
  source: string | null;
  suggestions: {
    campaign: string;
    campaign_id: string;
    /** Why it was suggested: same email domain, similar organisation, same last name. */
    why: string[];
    lead_count: number;
    examples: { name: string | null; email: string | null; company: string | null }[];
  }[];
  all: string[];
  /** Campaign ids the campaign list could not name — stale cache or archived. */
  unnamed_campaign_ids: string[];
  /** False means Instantly was never asked, which an empty list otherwise hides. */
  configured: boolean;
};

/**
 * Asked per booking, when the picker opens — each answer costs several Instantly
 * searches, and almost every row already knows its campaign and will never be asked.
 */
export const fetchCampaignOptions = (id: number) =>
  get<CampaignOptions>(`bookings/${id}/campaign-options`);

/** Applies a manual override to one booking. */
export async function patchBooking(id: number, patch: BookingPatch): Promise<void> {
  const res = await fetch(`/api/marketing/bookings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Could not update booking: ${res.status}`);
}

/** Re-runs enrichment upstream — the dashboard's "Refresh data". */
export async function refreshEnrichment(): Promise<void> {
  const res = await fetch('/api/marketing/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
}

/* ── Range helpers ──────────────────────────────────────────────── */

/*
 * Ranges are calendar periods on NPSA's clock, Central, matching the backend,
 * which cuts every series in America/Chicago. They replaced rolling 30- and
 * 90-day windows: "last month" should mean all of August, not the 30 days
 * before today, and a period should be compared with the same point in the
 * period before it (Sep 1-21 against Aug 1-21), not with a whole period.
 *
 * All window math is on Central calendar dates held as 'YYYY-MM-DD' strings.
 * They compare correctly as strings, and cannot drift with the viewer's own
 * time zone the way Date arithmetic on the browser clock would.
 */
export const REPORT_TZ = 'America/Chicago';
const CENTRAL_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The Central calendar date of an instant, as 'YYYY-MM-DD'. */
export const centralDate = (at: string | Date): string =>
  CENTRAL_DAY.format(typeof at === 'string' ? new Date(at) : at);

/** Half-open window of Central dates: from <= date < to. null is unbounded. */
export type Window = { from: string | null; to: string | null };

// Date.UTC normalises overflow, so month 0 is last December and day 0 is the
// last day of the month before -- which is all the calendar arithmetic needed.
const ymd = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parts = (date: string): [number, number, number] =>
  date.split('-').map(Number) as [number, number, number];

export const inWindow = (date: string, w: Window): boolean =>
  (!w.from || date >= w.from) && (!w.to || date < w.to);

/** The window a range covers, as of `today` (a Central date). */
export function rangeWindow(range: Range, today: string = centralDate(new Date())): Window {
  const [y, m] = parts(today);
  switch (range) {
    case 'month': return { from: ymd(y, m, 1), to: null };
    case 'lastmonth': return { from: ymd(y, m - 1, 1), to: ymd(y, m, 1) };
    case 'quarter': return { from: ymd(y, m - ((m - 1) % 3), 1), to: null };
    case 'ytd': return { from: ymd(y, 1, 1), to: null };
    default: return { from: null, to: null };
  }
}

/**
 * What a range is compared against: the same point in the period before.
 * This month so far compares with last month up to the same day; a finished
 * month compares with the whole month before it. A day that does not exist in
 * the earlier month clamps to its last day, so Mar 31 compares with Feb 1-28.
 */
export function priorWindow(range: Range, today: string = centralDate(new Date())): Window | null {
  const [y, m, d] = parts(today);
  // The earlier period, `back` months ago, up to the same day of the month.
  const samePoint = (fromMonth: number, back: number): Window => {
    const [py, pm] = parts(ymd(y, m - back, 1));
    return { from: ymd(y, fromMonth, 1), to: ymd(py, pm, Math.min(d, daysIn(py, pm)) + 1) };
  };
  switch (range) {
    case 'month': return samePoint(m - 1, 1);
    case 'lastmonth': return { from: ymd(y, m - 2, 1), to: ymd(y, m - 1, 1) };
    case 'quarter': return samePoint(m - ((m - 1) % 3) - 3, 3);
    case 'ytd': return samePoint(1 - 12, 12);
    default: return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "Aug 1–21", "July", "Apr 1–Jun 21", with the year only when it is not this one. */
export function windowLabel(w: Window, today: string = centralDate(new Date())): string {
  if (!w.from || !w.to) return '';
  const [fy, fm, fd] = parts(w.from);
  const [ty, tm, td] = parts(w.to);
  const [ly, lm, ld] = parts(ymd(ty, tm, td - 1)); // the last day inside the window
  const year = ly !== parts(today)[0] ? `, ${ly}` : '';
  if (fd === 1 && fy === ly && fm === lm && ld === daysIn(ly, lm)) return `${MONTHS_LONG[lm - 1]}${year}`;
  if (fy === ly && fm === lm && fd === ld) return `${MONTHS[fm - 1]} ${fd}${year}`;
  if (fy === ly && fm === lm) return `${MONTHS[fm - 1]} ${fd}–${ld}${year}`;
  return `${MONTHS[fm - 1]} ${fd}–${MONTHS[lm - 1]} ${ld}${year}`;
}

export type Totals = {
  booked: number;
  held: number;
  loes: number;
  won: number;
  /** Meetings whose outcome is known — the honest denominator for a held rate. */
  resolved: number;
  wonAmount: number;
};

const EMPTY: Totals = { booked: 0, held: 0, resolved: 0, loes: 0, won: 0, wonAmount: 0 };

/** Totals over a window. The rows must be the DAILY series: week and month
 *  buckets straddle calendar edges and cannot be cut to a window exactly. */
function sum(rows: TimeseriesRow[], w: Window): Totals {
  return rows.reduce<Totals>((acc, r) => {
    if (!inWindow(r.period.slice(0, 10), w)) return acc;
    return {
      booked: acc.booked + (Number(r.booked) || 0),
      held: acc.held + (Number(r.held) || 0),
      // A backend that predates `resolved` reports nothing, and falling back to
      // `booked` reproduces the old behaviour rather than dividing by zero.
      resolved: acc.resolved + (Number(r.resolved ?? r.booked) || 0),
      loes: acc.loes + (Number(r.clients) || 0),
      won: acc.won + (Number(r.won) || 0),
      wonAmount: acc.wonAmount + (Number(r.won_amount) || 0),
    };
  }, { ...EMPTY });
}

export function totalsFor(daily: TimeseriesRow[], range: Range, today?: string): Totals {
  return sum(daily, rangeWindow(range, today));
}

export function priorTotalsFor(daily: TimeseriesRow[], range: Range, today?: string): Totals {
  const w = priorWindow(range, today);
  return w ? sum(daily, w) : { ...EMPTY };
}

/**
 * Upstream leaves excluded and cancelled bookings out of every total, so the
 * client-side aggregates must too — otherwise the channel and campaign tables
 * quietly disagree with the KPIs above them.
 */
export const countsTowardTotals = (b: BookingRow): boolean =>
  !b.exclusion_reason && !b.cancelled;

/**
 * The date a booking is credited to in any range: the day the appointment was
 * first set, not the day it last moved. A reschedule is a brand new Calendly
 * booking, so its own booked_on is the day of the reschedule, and counting that
 * would move the appointment into whichever range it happened to be rescheduled
 * in. Upstream buckets its tiles and chart on the same date, and these panels sit
 * directly beneath them, so they have to agree.
 */
export const creditedOn = (b: BookingRow): string | null =>
  b.originated_on ?? b.booked_on;

const ATTRIBUTION_NOTES: Record<string, string> = {
  utm: 'read straight off the booking link',
  reverse_email: 'matched to an Instantly lead by email',
  reverse_name_org: 'matched to an Instantly lead by name and organization',
  reverse_domain: 'matched only on email domain — may be a colleague’s campaign',
  manual: 'set by hand',
  none: 'no campaign found',
};

/** Why this booking carries the campaign it does, in words. */
export function attributionNote(source?: string | null): string {
  const key = (source || '').trim();
  if (!key) return 'Attribution source not recorded';
  return `Attribution: ${ATTRIBUTION_NOTES[key] || key}`;
}

/** LOE fee value booked in the range — the time series doesn't carry fees. */
export function feesInRange(bookings: BookingRow[], range: Range, today?: string): number {
  const w = rangeWindow(range, today);
  return bookings.reduce((n, b) => {
    if (!countsTowardTotals(b)) return n;
    const credited = creditedOn(b);
    if (!credited || !inWindow(centralDate(credited), w)) return n;
    return b.became_client ? n + (Number(b.fee) || 0) : n;
  }, 0);
}

/** "Apr 2026" for months, "Q2 2026" for quarters. */
export function salesPeriodLabel(period: string, gran: SalesGranularity): string {
  const d = new Date(`${period}T00:00:00`);
  if (gran === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

/** "4/20" for weeks, "Apr 2026" for months. */
export function periodLabel(period: string, gran: Granularity): string {
  const d = new Date(`${period}T00:00:00`);
  return gran === 'month'
    ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Narrowest comfortable spacing between two x-axis labels, in px, by how wide
 * the label text runs. One pitch cannot serve both: "7/13" sets about 24px of
 * ink and "Jul 2026" about 48px, so a value loose enough for months throws away
 * half the labels a week axis could carry.
 */
export const AXIS_LABEL_PITCH = { short: 44, long: 68 };

/** How many labels fit in `width`. Falls back until the axis has been measured. */
export function axisLabelCount(
  width: number,
  pitch: number = AXIS_LABEL_PITCH.long,
  fallback = 7
): number {
  if (!width) return fallback;
  return Math.max(2, Math.floor(width / pitch));
}

/**
 * Rough ink width of an axis label, in px. The axis is set in a monospace face
 * at 10px, where every character is very close to 6px wide, so counting
 * characters beats measuring the DOM for what this is used for.
 */
export const axisLabelInk = (label: string) => label.length * 6;

/**
 * How far to nudge an axis label back inside the plot, in px. 0 leaves it
 * centred on its bar, which is what every label but the outermost two wants.
 *
 * The outermost labels are centred on the outermost bars, whose centres sit half
 * a slot in from the edge of the plot — so a label wider than its slot hangs off
 * the end, far enough at phone widths to escape the card entirely.
 *
 * `text-align` cannot fix this. Browsers decline to push overflowing text past
 * the start edge of its box, so `text-align: right` on a label wider than its
 * slot leaves the text exactly where it was. A transform is not subject to that
 * clamp and costs no layout.
 */
export function axisLabelShift(
  index: number,
  label: string,
  { slotWidth, firstLabelled, lastIndex }: {
    slotWidth: number;
    firstLabelled: number;
    lastIndex: number;
  }
): number {
  if (!slotWidth) return 0;
  const overhang = (axisLabelInk(label) - slotWidth) / 2;
  if (overhang <= 0) return 0;
  if (index === lastIndex) return -overhang;
  if (index === firstLabelled) return overhang;
  return 0;
}

/**
 * Which bar indices get an x-axis label.
 *
 * The stride is a constant integer, which is the entire point. Spreading labels
 * with `Math.round(k * (n - 1) / (t - 1))` reads as even but is not: 14 bars
 * into 7 labels lands on 0,2,4,7,9,11,13 — one three-wide gap among twos, which
 * is visible and looks like a mistake.
 *
 * Striding backwards from the newest bar keeps every gap identical and always
 * labels the most recent period, which is the one people read first. The cost is
 * that the oldest bar may go unlabelled when `count` is not a multiple of the
 * stride; an even axis is worth more than that label.
 */
export function axisLabelIndices(count: number, maxLabels: number): Set<number> {
  const set = new Set<number>();
  if (count <= 0) return set;
  const stride = Math.max(1, Math.ceil(count / Math.max(1, maxLabels)));
  for (let i = count - 1; i >= 0; i -= stride) set.add(i);
  return set;
}

/**
 * The bookings the KPI tiles above the list are actually counting.
 *
 * Every other figure on the marketing band is scoped by the range picker; the
 * list was not, so "held rate · 30d — 6 of 7 meetings held" sat directly above
 * every booking ever taken. There was no way to reconcile the two by eye, and
 * the tiles moving while the rows underneath them stayed put read as the list
 * failing to update.
 *
 * Excluded and cancelled rows still belong here — they are struck through and
 * labelled rather than hidden, which is the whole point of marking instead of
 * deleting. Only the window is applied.
 */
export function bookingsInRange(bookings: BookingRow[], range: Range, today?: string): BookingRow[] {
  if (range === 'all') return bookings;
  const w = rangeWindow(range, today);
  return bookings.filter((b) => {
    const credited = creditedOn(b);
    return !credited || inWindow(centralDate(credited), w);
  });
}

/** Range-scoped channel breakdown, computed from raw bookings. */
export function channelsInRange(
  bookings: BookingRow[],
  range: Range,
  today?: string
): { name: string; booked: number; loes: number; won: number }[] {
  const w = rangeWindow(range, today);
  const map = new Map<string, { booked: number; loes: number; won: number }>();
  for (const b of bookings) {
    if (!countsTowardTotals(b)) continue;
    const credited = creditedOn(b);
    if (!credited || !inWindow(centralDate(credited), w)) continue;
    const key = channelLabel(b.attribution_channel);
    const cur = map.get(key) || { booked: 0, loes: 0, won: 0 };
    cur.booked += 1;
    if (b.became_client) cur.loes += 1;
    if (b.won) cur.won += Number(b.won_amount) || 0;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.booked - a.booked);
}

/**
 * Campaign names Instantly no longer answers to, because the campaign was renamed
 * under them, mapped to the id and the current name.
 *
 * The backend keeps the same map, but only the id: it resolves the name live from
 * Instantly. The browser has no such call, so the name is carried here too --
 * which means this list has to be updated on a rename, and the id is what saves it
 * from being wrong in the meantime. Rows with an id do not consult this at all;
 * it is only for bookings enriched before instantly_campaign_id existed.
 */
const CAMPAIGN_DEAD_NAMES: Record<string, { id: string; name: string }> = {
  'remarket fy27 - non-repliers (excl il, ca)': {
    id: '8552c05f-c927-48ee-b654-66f33e1c5cf1',
    name: 'Remarket FY27 - Non-Repliers',
  },
  'ca outreach - csnsgp fy26 (6-step)': {
    id: '28c9205e-23fe-4e10-b5fc-839cb2e9f0ab',
    name: 'CA Outreach - CSNSGP FY26',
  },
  'il outreach - uncontacted (6-step)': {
    id: 'e16e3d42-d3bc-40ce-88e8-756b2aa79ee8',
    name: 'IL Outreach - Uncontacted',
  },
};

/**
 * Range-scoped breakdown by campaign AND source, which is what the panel is
 * titled and what the upstream by-campaign table has always returned.
 *
 * It used to key on the campaign name alone and pool everything else into one
 * "— no campaign —" row. That row read as 53 bookings whose attribution had been
 * lost, when 51 of them were never campaign traffic in the first place: 47 direct,
 * 2 referral, 1 past engaged prospect, 1 organic search. Only 2 were Instantly
 * bookings whose campaign genuinely could not be worked out, and those are the
 * ones worth chasing -- so they are the ones the row now names.
 */
export function campaignsInRange(
  bookings: BookingRow[],
  range: Range,
  today?: string
): { campaign: string; isCampaign: boolean; booked: number; held: number; loes: number; fees: number }[] {
  const w = rangeWindow(range, today);

  // A campaign renamed in Instantly leaves its OLD name on every booking taken
  // before the rename, so grouping on the name alone splits one campaign into two
  // rows -- three were showing as separate one-booking campaigns when this was
  // written, and #158 and #173 could not stop it because they fixed the fold in
  // by-campaign, which this panel does not call.
  //
  // Grouping on the id alone does not work either: a booking enriched before the
  // id column existed has none, and would not merge with one that does. So the
  // key is a canonical NAME, and the id is what canonicalises it -- every row
  // sharing an id resolves to the same name, whichever of its names it carries.
  const idToName = new Map<string, string>();
  for (const b of bookings) {
    const id = b.instantly_campaign_id;
    const name = b.instantly_campaign?.trim();
    if (!id || !name) continue;
    // Prefer a name Instantly still answers to: a dead one only wins if it is all
    // this id ever appears with.
    if (!idToName.has(id) || CAMPAIGN_DEAD_NAMES[idToName.get(id)!.toLowerCase()]) {
      idToName.set(id, name);
    }
  }

  const map = new Map<
    string,
    { campaign: string; isCampaign: boolean; booked: number; held: number; loes: number; fees: number }
  >();
  for (const b of bookings) {
    if (!countsTowardTotals(b)) continue;
    const credited = creditedOn(b);
    if (!credited || !inWindow(centralDate(credited), w)) continue;
    const stored = b.instantly_campaign?.trim();
    // The id names the campaign when there is one. Failing that -- rows older than
    // the column -- the dead-name map does, and failing that the stored name is
    // all there is.
    const named =
      (b.instantly_campaign_id ? idToName.get(b.instantly_campaign_id) : undefined) ??
      (stored ? CAMPAIGN_DEAD_NAMES[stored.toLowerCase()]?.name : undefined) ??
      stored;
    // An Instantly booking with no campaign is a real gap. Anything else simply
    // came from somewhere that is not a campaign, and says so.
    const key =
      named ||
      (b.attribution_channel === 'instantly'
        ? 'Instantly — campaign unknown'
        : channelLabel(b.attribution_channel));
    const cur = map.get(key) || {
      campaign: key, isCampaign: Boolean(named), booked: 0, held: 0, loes: 0, fees: 0,
    };
    cur.booked += 1;
    if (b.held) cur.held += 1;
    if (b.became_client) {
      cur.loes += 1;
      cur.fees += Number(b.fee) || 0;
    }
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.booked - a.booked);
}

const CHANNEL_LABELS: Record<string, string> = {
  instantly: 'Instantly',
  google_ads: 'Google Ads',
  search: 'Organic Search',
  email: 'Email',
  social: 'Social',
  referral: 'Referral',
  conference: 'Conference',
  linkedin: 'LinkedIn',
  past_engaged_prospect: 'Past Engaged Prospect',
  direct: 'Direct / Other',
  google: 'Google',
  organic: 'Organic',
};

/**
 * Calendly gives the host as an email address; the local part is the useful bit.
 * "jeff@npsa.com" reads as "Jeff".
 */
export function hostName(host?: string | null): string {
  const h = (host || '').trim();
  if (!h) return '';
  const local = h.split('@')[0] || h;
  const first = local.split(/[._-]/)[0] || local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function channelLabel(c?: string | null): string {
  const key = c?.trim();
  if (!key) return 'Direct / Other';
  return CHANNEL_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

export const RANGE_WORD: Record<Range, string> = {
  month: 'this month',
  lastmonth: 'last month',
  quarter: 'this quarter',
  ytd: 'year to date',
  all: 'all time',
};

/** The bookings endpoint caps at 500 rows; used to flag possible truncation. */
export const BOOKINGS_LIMIT = 500;

const RANGE_KEY = 'npsa-range';
const VALID: Range[] = ['month', 'lastmonth', 'quarter', 'ytd', 'all'];
// A browser that last used the rolling windows keeps the nearest calendar period.
const LEGACY: Record<string, Range> = { '30d': 'month', '90d': 'quarter' };

export function loadRange(fallback: Range = 'quarter'): Range {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(RANGE_KEY) || '';
    const v = (LEGACY[raw] ?? raw) as Range;
    return VALID.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveRange(range: Range): void {
  try {
    localStorage.setItem(RANGE_KEY, range);
  } catch {
    /* private mode — selection just won't persist */
  }
}
