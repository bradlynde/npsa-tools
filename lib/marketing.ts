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
  instantly_campaign: string | null;
  host: string | null;
  held: boolean | null;
  became_client: boolean | null;
  fee: number;
  won: boolean | null;
  won_amount: number;
};

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
  ok?: boolean | null;
  finished_at?: string | null;
  rows_seen?: number | null;
  error?: string | null;
  note?: string | null;
};

export type SyncStatus = { runs?: SyncRun[]; pull_configured?: boolean };

export type Funnel = {
  booked: number;
  held: number;
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

/** Toggles Held / LOE-sent on a single booking (the manual override). */
export async function patchBooking(
  id: number,
  field: 'held' | 'became_client',
  value: boolean
): Promise<void> {
  const res = await fetch(`/api/marketing/bookings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ [field]: value }),
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
  wonAmount: number;
};

const EMPTY: Totals = { booked: 0, held: 0, loes: 0, won: 0, wonAmount: 0 };

function sum(rows: TimeseriesRow[], from: Date, to?: Date): Totals {
  return rows.reduce<Totals>((acc, r) => {
    const d = new Date(`${r.period}T00:00:00`);
    if (d < from) return acc;
    if (to && d >= to) return acc;
    return {
      booked: acc.booked + (Number(r.booked) || 0),
      held: acc.held + (Number(r.held) || 0),
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

/** LOE fee value booked in the range — the time series doesn't carry fees. */
export function feesInRange(bookings: BookingRow[], range: Range): number {
  const from = rangeStart(range);
  return bookings.reduce((n, b) => {
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

/** Range-scoped channel breakdown, computed from raw bookings. */
export function channelsInRange(
  bookings: BookingRow[],
  range: Range
): { name: string; booked: number; loes: number; won: number }[] {
  const from = rangeStart(range);
  const map = new Map<string, { booked: number; loes: number; won: number }>();
  for (const b of bookings) {
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
  direct: 'Direct / Other',
  google: 'Google',
  organic: 'Organic',
};

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
