/** WhatsApp-style relative time for conversation rows.
 *
 * "now", "5m", "2h", "Yesterday", "Mon", "12 Jan" — the compact rail text a
 * native chat list shows beside each row. Day boundaries are the owner's
 * (Asia/Dubai), same as groupByRecency; a timestamp we cannot parse renders
 * as an empty string rather than "NaN" or a wrong date.
 */

const TIME_ZONE = 'Asia/Dubai';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const weekdayFormat = new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, weekday: 'short' });
const monthDayFormat = new Intl.DateTimeFormat('en', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
});
const fullFormat = new Intl.DateTimeFormat('en', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Whole Dubai-calendar days from `then` to `now`. */
function dayDiff(now: number, then: number): number {
  const a = dayFormat.format(now);
  const b = dayFormat.format(then);
  return Math.round((Date.parse(a) - Date.parse(b)) / DAY_MS);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const diff = now - at;
  // A clock that runs ahead (or a just-written row) is "now", not "-3m".
  if (diff < MINUTE_MS) return 'now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
  const days = dayDiff(now, at);
  if (days <= 0) return `${Math.floor(diff / HOUR_MS)}h`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFormat.format(at);
  const sameYear =
    new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, year: 'numeric' }).format(now) ===
    new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, year: 'numeric' }).format(at);
  return sameYear ? monthDayFormat.format(at) : fullFormat.format(at);
}
