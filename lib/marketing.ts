/**
 * Client for the Sales Toolbox marketing data, via the same-origin proxy at
 * /api/marketing/* (see app/api/marketing/[...path]/route.ts).
 *
 * The upstream endpoints report all-time totals and have no date-range filter,
 * so range-scoped figures (30d / 90d / YTD) are derived here from the weekly
 * time series, which is aggregated server-side and therefore uncapped.
 */

export type Range = '30d' | '90d' | 'ytd' | 'all';

export type TimeseriesRow = {
  period: string; // YYYY-MM-DD, start of week
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

export type BookingRow = {
  id: number;
  booked_on: string | null;
  organization: string | null;
  name: string | null;
  attribution_channel: string | null;
  held: boolean | null;
  became_client: boolean | null;
  won: boolean | null;
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

export const fetchTimeseries = () => get<TimeseriesRow[]>('timeseries?granularity=week');
export const fetchChannels = () => get<ChannelRow[]>('by-channel');
export const fetchBookings = () => get<BookingRow[]>('bookings');

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

/** The last `count` weeks of the series, oldest → newest, padded if sparse. */
export function recentWeeks(rows: TimeseriesRow[], count = 14): TimeseriesRow[] {
  const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period));
  return sorted.slice(-count);
}

/** "4/20" — short week label for the chart axis. */
export function weekLabel(period: string): string {
  const d = new Date(`${period}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Range-scoped channel breakdown, computed from raw bookings. */
export function channelsInRange(
  bookings: BookingRow[],
  range: Range
): { name: string; booked: number; won: number }[] {
  const from = rangeStart(range);
  const map = new Map<string, { booked: number; won: number }>();
  for (const b of bookings) {
    if (!b.booked_on) continue;
    if (new Date(b.booked_on) < from) continue;
    const key = b.attribution_channel?.trim() || 'Direct / Other';
    const cur = map.get(key) || { booked: 0, won: 0 };
    cur.booked += 1;
    if (b.won) cur.won += Number(b.won_amount) || 0;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.booked - a.booked);
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
