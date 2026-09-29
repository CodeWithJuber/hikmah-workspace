// Recency bucketing for the conversation list.
// Run: node --test tests/chat-grouping.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByRecency, RECENCY_ORDER, RECENCY_LABELS } from '../lib/chat/grouping.ts';

const entry = (id, updatedAt) => ({ id, updatedAt });

/** A Tuesday evening, 20:00 Asia/Dubai. */
const TUE = Date.parse('2026-09-29T20:00:00+04:00');

test('buckets land on the Dubai calendar day', () => {
  const groups = groupByRecency(
    [
      entry('a', '2026-09-29T19:59:00+04:00'),
      entry('b', '2026-09-29T00:05:00+04:00'),
      entry('c', '2026-09-28T23:00:00+04:00'),
      entry('d', '2026-09-23T12:00:00+04:00'),
      entry('e', '2026-08-30T12:00:00+04:00'),
    ],
    TUE,
  );
  assert.deepEqual(
    groups.today.map((x) => x.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    groups.yesterday.map((x) => x.id),
    ['c'],
  );
  assert.deepEqual(
    groups.last7days.map((x) => x.id),
    ['d'],
  );
  assert.deepEqual(
    groups.earlier.map((x) => x.id),
    ['e'],
  );
});

test('a UTC timestamp just before Dubai midnight is still today', () => {
  // 2026-09-29T19:59:59Z is 23:59:59 in Dubai — same Dubai day, so today.
  const groups = groupByRecency([entry('a', '2026-09-29T19:59:59Z')], TUE);
  assert.deepEqual(
    groups.today.map((x) => x.id),
    ['a'],
  );
  assert.deepEqual(groups.yesterday, []);
});

test('midnight boundary in Dubai flips today to yesterday', () => {
  const justPastMidnight = Date.parse('2026-09-30T00:00:30+04:00');
  const groups = groupByRecency(
    [entry('late', '2026-09-29T23:59:59+04:00'), entry('early', '2026-09-30T00:00:01+04:00')],
    justPastMidnight,
  );
  assert.deepEqual(
    groups.yesterday.map((x) => x.id),
    ['late'],
  );
  assert.deepEqual(
    groups.today.map((x) => x.id),
    ['early'],
  );
});

test('last-7-days covers 2 to 7 days back, earlier takes the rest', () => {
  const groups = groupByRecency(
    [
      entry('two', '2026-09-27T20:00:00+04:00'),
      entry('seven', '2026-09-22T20:00:00+04:00'),
      entry('eight', '2026-09-21T20:00:00+04:00'),
    ],
    TUE,
  );
  assert.deepEqual(
    groups.last7days.map((x) => x.id),
    ['two', 'seven'],
  );
  assert.deepEqual(
    groups.earlier.map((x) => x.id),
    ['eight'],
  );
});

test('an unparsable timestamp lands in earlier, never in today', () => {
  const groups = groupByRecency([entry('bad', 'not-a-date')], TUE);
  assert.deepEqual(
    groups.earlier.map((x) => x.id),
    ['bad'],
  );
  assert.deepEqual(groups.today, []);
});

test('empty input yields four empty buckets, and the order is fixed', () => {
  const groups = groupByRecency([], TUE);
  for (const bucket of RECENCY_ORDER) assert.deepEqual(groups[bucket], []);
  assert.deepEqual(RECENCY_LABELS, {
    today: 'Today',
    yesterday: 'Yesterday',
    last7days: 'Last 7 days',
    earlier: 'Earlier',
  });
});
