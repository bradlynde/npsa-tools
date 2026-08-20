/**
 * Client for the Sales Toolbox marketing data, via the same-origin proxy at
 * /api/marketing/* (see app/api/marketing/[...path]/route.ts).
 *
 * The upstream endpoints report all-time totals and have no date-range filter,
 * so range-scoped figures (30d / 90d / YTD) are derived here from the weekly
 * time series, which is aggregated server-side and therefore uncapped.
 */

export type Range = '30d' | '90d' | 'ytd' | 'all';
export type Granularity = 'week' | 'month';
export type SalesGranularity = 'month' | 'quarter';

export type TimeseriesRow = {
  period: string; // YYYY-MM-DD, start of the week or month
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
  meeting_date: string | null;
  name: string | null;
  organization: string | null;
  email: string | null;
  told_us: string | null;
  attribution_channel: string | null;
  /** Which rule supplied the campaign — see attributionNote(). */
  attribution_source?: string | null;
  instantly_campaign: string | null;
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
export const fetchTimeseries = (gran: Granularity = 'week') =>
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

/** Inclusive lower bound for a range, relative to now. */
export function rangeStart(range: Range): Date {
  const now = new Date();
  if (range === 'all') return new Date(0);
  if (range === 'ytd') return new Date(now.getFullYear(), 0, 1);
  const days = range === '30d' ? 30 : 90;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

/** The equivalent window immediately before `range`, for period-over-period deltas. */
function priorWindow(range: Range): { from: Date; to: Date } | null {
  // All-time has nothing before it to compare against.
  if (range === 'all') return null;
  const to = rangeStart(range);
  const from = new Date(to);
  if (range === 'ytd') from.setFullYear(from.getFullYear() - 1);
  else from.setDate(from.getDate() - (range === '30d' ? 30 : 90));
  return { from, to };
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

function sum(rows: TimeseriesRow[], from: Date, to?: Date): Totals {
  return rows.reduce<Totals>((acc, r) => {
    const d = new Date(`${r.period}T00:00:00`);
    if (d < from) return acc;
    if (to && d >= to) return acc;
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

export function totalsFor(rows: TimeseriesRow[], range: Range): Totals {
  return sum(rows, rangeStart(range));
}

export function priorTotalsFor(rows: TimeseriesRow[], range: Range): Totals {
  const w = priorWindow(range);
  if (!w) return { ...EMPTY };
  return sum(rows, w.from, w.to);
}

/**
 * Upstream leaves excluded and cancelled bookings out of every total, so the
 * client-side aggregates must too — otherwise the channel and campaign tables
 * quietly disagree with the KPIs above them.
 */
export const countsTowardTotals = (b: BookingRow): boolean =>
  !b.exclusion_reason && !b.cancelled;

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
export function feesInRange(bookings: BookingRow[], range: Range): number {
  const from = rangeStart(range);
  return bookings.reduce((n, b) => {
    if (!countsTowardTotals(b)) return n;
    if (!b.booked_on || new Date(b.booked_on) < from) return n;
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
export function bookingsInRange(bookings: BookingRow[], range: Range): BookingRow[] {
  if (range === 'all') return bookings;
  const from = rangeStart(range);
  return bookings.filter((b) => !b.booked_on || new Date(b.booked_on) >= from);
}

/** Range-scoped channel breakdown, computed from raw bookings. */
export function channelsInRange(
  bookings: BookingRow[],
  range: Range
): { name: string; booked: number; loes: number; won: number }[] {
  const from = rangeStart(range);
  const map = new Map<string, { booked: number; loes: number; won: number }>();
  for (const b of bookings) {
    if (!countsTowardTotals(b)) continue;
    if (!b.booked_on) continue;
    if (new Date(b.booked_on) < from) continue;
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

/** Range-scoped campaign breakdown, mirroring the upstream by-campaign table. */
export function campaignsInRange(
  bookings: BookingRow[],
  range: Range
): { campaign: string; booked: number; held: number; loes: number; fees: number }[] {
  const from = rangeStart(range);
  const map = new Map<string, { booked: number; held: number; loes: number; fees: number }>();
  for (const b of bookings) {
    if (!countsTowardTotals(b)) continue;
    if (!b.booked_on) continue;
    if (new Date(b.booked_on) < from) continue;
    const key = b.instantly_campaign?.trim() || '— no campaign —';
    const cur = map.get(key) || { booked: 0, held: 0, loes: 0, fees: 0 };
    cur.booked += 1;
    if (b.held) cur.held += 1;
    if (b.became_client) {
      cur.loes += 1;
      cur.fees += Number(b.fee) || 0;
    }
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([campaign, v]) => ({ campaign, ...v }))
    .sort((a, b) => b.booked - a.booked);
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
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  ytd: 'year to date',
  all: 'all time',
};

/** The bookings endpoint caps at 500 rows; used to flag possible truncation. */
export const BOOKINGS_LIMIT = 500;

const RANGE_KEY = 'npsa-range';
const VALID: Range[] = ['30d', '90d', 'ytd', 'all'];

export function loadRange(fallback: Range = '90d'): Range {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(RANGE_KEY) as Range | null;
    return v && VALID.includes(v) ? v : fallback;
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
