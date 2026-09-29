/** Recency bucketing for the conversation list.
 *
 * "Today" means the owner's today, and the owner is on Asia/Dubai — so day
 * boundaries are computed in that timezone, not UTC and not the viewer's.
 * The boundaries live here (a pure, unit-testable function) rather than in
 * the component, so a timezone bug shows up in a test, not in the drawer.
 */

export type RecencyBucket = 'today' | 'yesterday' | 'last7days' | 'earlier';

export type GroupedByRecency<T> = Record<RecencyBucket, T[]>;

export const RECENCY_ORDER: readonly RecencyBucket[] = [
  'today',
  'yesterday',
  'last7days',
  'earlier',
];

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7days: 'Last 7 days',
  earlier: 'Earlier',
};

const TIME_ZONE = 'Asia/Dubai';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Dubai calendar day (YYYY-MM-DD) a timestamp falls on. */
function dubaiDay(ms: number): string {
  return dayFormat.format(ms);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole Dubai-calendar days from `b` to `a`. Both strings are YYYY-MM-DD,
 * parsed as UTC midnight — consistent for both sides, so the diff is exact. */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / DAY_MS);
}

/** Bucket entries by the Dubai-calendar recency of their `updatedAt`.
 * Order inside each bucket is the input order; a timestamp we cannot parse
 * lands in "earlier" rather than polluting "Today". */
export function groupByRecency<T extends { updatedAt: string }>(
  entries: readonly T[],
  now: number = Date.now(),
): GroupedByRecency<T> {
  const today = dubaiDay(now);
  const groups: GroupedByRecency<T> = { today: [], yesterday: [], last7days: [], earlier: [] };
  for (const entry of entries) {
    const at = Date.parse(entry.updatedAt);
    let bucket: RecencyBucket = 'earlier';
    if (!Number.isNaN(at)) {
      const diff = dayDiff(today, dubaiDay(at));
      bucket = diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : diff <= 7 ? 'last7days' : 'earlier';
    }
    groups[bucket].push(entry);
  }
  return groups;
}
