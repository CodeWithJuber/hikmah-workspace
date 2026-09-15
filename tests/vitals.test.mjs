// Page vitals: the store, and the p75 the owner console reads.
//
// The value of this table is entirely in the numbers being right — a p75 that
// is quietly a median, or a route column that quietly holds a conversation id,
// would be worse than having no telemetry at all, because it would be believed.
// Run: node --test tests/vitals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createVitalsStore, VITAL_METRICS } from '../lib/vitals/store.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0016_page_vitals.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return { db, store: createVitalsStore(db) };
}

const sample = (over = {}) => ({
  userId: null,
  route: '/chat',
  metric: 'LCP',
  value: 1000,
  rating: 'good',
  width: 'phone',
  release: '9.1',
  ...over,
});

test('a signed-out visitor is measured, and leaves no identity behind', (t) => {
  const { db, store } = setup(t);
  store.record(sample());
  const row = db.prepare('SELECT * FROM page_vitals').get();
  assert.equal(row.user_id, null);
  assert.equal(row.route, '/chat');
  assert.equal(row.value, 1000);
  // The columns that exist are the columns that exist. If a later change adds
  // an address, a user agent or a session id, this is where it is noticed.
  assert.deepEqual(Object.keys(row).sort(), [
    'created_at',
    'id',
    'metric',
    'rating',
    'release',
    'route',
    'user_id',
    'value',
    'width',
  ]);
});

test('CLS survives being stored, which an integer column would not have', (t) => {
  const { db, store } = setup(t);
  store.record(sample({ metric: 'CLS', value: 0.0821 }));
  assert.equal(db.prepare('SELECT value FROM page_vitals').get().value, 0.0821);
});

test('the summary reports p75, not a mean', (t) => {
  const { store } = setup(t);
  // 1..100. The mean is 50.5 and the 75th percentile is 75 — the smallest value
  // at or below which 75 of the 100 samples fall. One slow outlier
  // moves the first and not the second, which is the whole reason Core
  // Web Vitals is defined at p75.
  for (let n = 1; n <= 100; n += 1) store.record(sample({ value: n }));
  const [row] = store.summary();
  assert.equal(row.samples, 100);
  assert.equal(row.p75, 75);
  assert.notEqual(row.p75, 50.5);
});

test('one terrible load does not become the number', (t) => {
  const { store } = setup(t);
  for (let n = 0; n < 99; n += 1) store.record(sample({ value: 500 }));
  store.record(sample({ value: 600_000, rating: 'poor' }));
  const [row] = store.summary();
  assert.equal(row.p75, 500);
  assert.equal(row.poor, 1);
});

test('phone and desktop are counted apart, which is the point of the column', (t) => {
  const { store } = setup(t);
  for (let n = 0; n < 4; n += 1) store.record(sample({ width: 'phone', value: 4000 }));
  for (let n = 0; n < 4; n += 1) store.record(sample({ width: 'desktop', value: 400 }));
  const rows = store.summary();
  assert.equal(rows.length, 2);
  const byWidth = Object.fromEntries(rows.map((row) => [row.width, row.p75]));
  assert.equal(byWidth.phone, 4000);
  assert.equal(byWidth.desktop, 400);
});

test('the route the browser may send is a template, never a conversation', () => {
  // The allowlist in app/api/vitals/route.ts is what enforces this, so this
  // reads it rather than trusting the comment above it: '/chat' is acceptable
  // and '/chat/[id]' is not, so there is no spelling of a conversation id that
  // the route would store.
  const route = readFileSync(new URL('../app/api/vitals/route.ts', import.meta.url), 'utf8');
  const list = route.slice(route.indexOf('const ROUTES'), route.indexOf('])'));
  assert.match(list, /'\/chat'/);
  assert.equal(/\[id\]|\[\.\.\./.test(list), false, 'a parameterised route is in the allowlist');
  for (const path of list.matchAll(/'([^']+)'/g))
    assert.equal(path[1].split('/').length, 2, `${path[1]} has more than one segment`);
});

test('the reporter sends only the metrics the store accepts', () => {
  const reporter = readFileSync(
    new URL('../components/vitals-reporter.tsx', import.meta.url),
    'utf8',
  );
  // web-vitals' onX names map to the metric names one-for-one, so a sixth
  // observer added to the reporter without being added to VITAL_METRICS would
  // beacon rows the route silently drops.
  const observed = [...reporter.matchAll(/\bon(CLS|INP|LCP|FCP|TTFB|[A-Z]{2,5})\b/g)].map(
    (m) => m[1],
  );
  for (const metric of new Set(observed))
    assert.ok(
      VITAL_METRICS.includes(metric),
      `the reporter observes ${metric}, the store does not`,
    );
});
