// The compact time rail of a native chat list. Dubai-calendar days, like the
// recency buckets — a message from "today" is never labelled with a weekday.
// Run: node --test tests/relative-time.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../lib/chat/relative-time.ts';

// 2026-09-29 16:00 +04 == 12:00 UTC. Fixed clock, no flakiness.
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

test('under a minute is "now"', () => {
  assert.equal(relativeTime(iso(NOW - 30 * 1000), NOW), 'now');
});

test('a future timestamp (clock skew) is "now", never negative', () => {
  assert.equal(relativeTime(iso(NOW + 5 * 60 * 1000), NOW), 'now');
});

test('minutes and hours are compact', () => {
  assert.equal(relativeTime(iso(NOW - 5 * 60 * 1000), NOW), '5m');
  assert.equal(relativeTime(iso(NOW - 2 * 60 * 60 * 1000), NOW), '2h');
});

test('same Dubai day, many hours ago, stays hours', () => {
  // 10 hours back is 02:00 UTC = 06:00 +04 — still the 29th in Dubai.
  assert.equal(relativeTime(iso(NOW - 10 * 60 * 60 * 1000), NOW), '10h');
});

test('yesterday is a word, not a date', () => {
  // 20 hours back is 2026-09-28 16:00 UTC = 20:00 +04 on the 28th.
  assert.equal(relativeTime(iso(NOW - 20 * 60 * 60 * 1000), NOW), 'Yesterday');
});

test('this week is a weekday', () => {
  // 3 days back: 2026-09-26, a Saturday.
  assert.equal(relativeTime(iso(NOW - 3 * 24 * 60 * 60 * 1000), NOW), 'Sat');
});

test('older this year is day + month', () => {
  assert.equal(relativeTime(iso(Date.UTC(2026, 4, 3, 8, 0, 0)), NOW), 'May 3');
});

test('last year carries the year', () => {
  assert.equal(relativeTime(iso(Date.UTC(2025, 11, 25, 8, 0, 0)), NOW), 'Dec 25, 2025');
});

test('an unparseable timestamp renders empty, never NaN', () => {
  assert.equal(relativeTime('not-a-date', NOW), '');
  assert.equal(relativeTime('', NOW), '');
});
