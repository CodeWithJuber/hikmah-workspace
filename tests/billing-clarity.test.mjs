// PR-15 — usage and billing clarity.
//
// Free-trial wording states the terms exactly; a failed renewal degrades
// gracefully with the user told; consent to be charged is recorded before any
// checkout; a tier cycle never deletes usage or run history; the meter reads
// live from the ledger PR-04 built.
//
// Run: node --test tests/billing-clarity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { applySchema } from './schema.mjs';
import { tierForSubscription, resolveBillingEvents } from '../server/billing-sync.mjs';
import { planById, priceLabelFor, trialTermsFor } from '../server/plans.mjs';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-billing-clarity-'));
await build({
  entryPoints: ['lib/billing/store.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { createBillingStore } = await import(pathToFileURL(join(dir, 'store.mjs')));

const pro = () => planById('pro');
const free = () => planById('free');

function withEnv(vars, fn) {
  const previous = { ...process.env };
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
    Object.assign(process.env, previous);
  }
}

test('trial terms state exactly what ends, when, and what happens after', () => {
  withEnv({ HIKMAH_PRICE_PRO_LABEL: '$19 a month' }, () => {
    assert.equal(
      trialTermsFor(pro()),
      '14 days free. On day 15, the $19-a-month Pro charge starts automatically. ' +
        'Cancel any time before then and you pay nothing. ' +
        'Cancel later and you land back on Free, keeping every conversation and file.',
    );
  });
});

test('trial terms name the checkout price when the deployment has not set a label', () => {
  withEnv({ HIKMAH_PRICE_PRO_LABEL: undefined }, () => {
    assert.equal(
      trialTermsFor(pro()),
      '14 days free. When the trial ends, the Pro price shown at checkout starts ' +
        'automatically. Cancel any time before then and you pay nothing. ' +
        'Cancel later and you land back on Free, keeping every conversation and file.',
    );
  });
});

test('a plan with no trial carries no trial terms', () => {
  assert.equal(trialTermsFor(free()), '');
  assert.equal(priceLabelFor(free()), '$0');
});

test('a past-due subscription keeps the paid tier while Stripe retries', () => {
  // JEV 2026-09-30 (mirror_stripe, 0.82): demoting on the first failed charge
  // is a silent lockout during a window Stripe itself treats as temporary.
  assert.equal(tierForSubscription({ status: 'past_due', plan: 'pro' }), 'managed');
  assert.equal(tierForSubscription({ status: 'trialing', plan: 'pro' }), 'managed');
  assert.equal(tierForSubscription({ status: 'active', plan: 'pro' }), 'managed');
});

test('unpaid and canceled still fall back to the free tier', () => {
  for (const status of ['unpaid', 'canceled', 'incomplete', 'paused', undefined])
    assert.equal(tierForSubscription({ status, plan: 'pro' }), 'byok', String(status));
});

test('a failed renewal is recorded once, not once per webhook redelivery', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  const t0 = new Date('2026-09-30T01:00:00Z');
  assert.equal(store.paymentFailureNotice('u1'), null, 'no failure yet');

  resolveBillingEvents(db, 'u1', { status: 'past_due', plan: 'pro' }, t0);
  const notice = store.paymentFailureNotice('u1');
  assert.ok(notice, 'the failure is recorded');
  assert.equal(notice.at, t0.toISOString());

  // Stripe redelivers subscription.updated repeatedly while the card is
  // retried; each redelivery must not add another row.
  resolveBillingEvents(
    db,
    'u1',
    { status: 'past_due', plan: 'pro' },
    new Date('2026-09-30T02:00:00Z'),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE kind = 'payment_failed'").get().n,
    1,
    'one hour later: still the same failure, no new row',
  );

  // Two days later it is a new failure worth recording.
  resolveBillingEvents(
    db,
    'u1',
    { status: 'past_due', plan: 'pro' },
    new Date('2026-10-02T02:00:00Z'),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE kind = 'payment_failed'").get().n,
    2,
    'two days later: a new failure worth recording',
  );
  db.close();
});

test('a failure that Stripe later collects stops being news', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  const t0 = new Date('2026-09-30T01:00:00Z');
  const t1 = new Date('2026-09-30T02:00:00Z'); // redelivery while retrying
  const t2 = new Date('2026-10-01T01:00:00Z'); // the card worked again

  resolveBillingEvents(db, 'u1', { status: 'past_due', plan: 'pro' }, t0);
  resolveBillingEvents(db, 'u1', { status: 'past_due', plan: 'pro' }, t1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n,
    1,
    'redeliveries do not pile up',
  );
  assert.deepEqual(
    store.paymentFailureNotice('u1'),
    { at: t0.toISOString() },
    'the failure is news while it is unresolved',
  );

  resolveBillingEvents(db, 'u1', { status: 'active', plan: 'pro' }, t2);
  assert.equal(
    store.paymentFailureNotice('u1'),
    null,
    'a recovered failure must not keep warning the person',
  );

  // A later, separate failure is news again.
  resolveBillingEvents(
    db,
    'u1',
    { status: 'past_due', plan: 'pro' },
    new Date('2026-10-05T01:00:00Z'),
  );
  assert.ok(store.paymentFailureNotice('u1'), 'a new failure after recovery is news again');
  db.close();
});

test('an active subscription with no failure behind it records nothing', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  resolveBillingEvents(db, 'u1', { status: 'active', plan: 'pro' }, new Date());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n, 0);
  db.close();
});

test('consent to be charged is recorded with the exact terms', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  const terms = withEnv({ HIKMAH_PRICE_PRO_LABEL: '$19 a month' }, () => trialTermsFor(pro()));
  store.recordConsent({
    id: 'con_' + randomUUID(),
    userId: 'u1',
    planId: 'pro',
    priceLabel: '$19 a month',
    terms,
  });
  const rows = store.consentsFor('u1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plan_id, 'pro');
  assert.equal(rows[0].price_label, '$19 a month');
  assert.equal(rows[0].terms, terms, 'the exact terms the person agreed to');
  assert.ok(rows[0].agreed_at, 'the moment of consent is kept');
  assert.equal(store.consentsFor('u2').length, 0, 'consent does not leak between accounts');
  db.close();
});

test('a tier cycle never deletes usage or run history', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  // Upgrade: the person pays, the deployment meters their runs.
  store.setTier('u1', 'managed');
  const event = (id, tokens) => ({
    id,
    userId: 'u1',
    runId: 'r-' + id,
    model: 'a/b',
    metered: true,
    inputTokens: tokens,
    outputTokens: 0,
  });
  store.recordUsage(event('1', 100));
  store.recordUsage(event('2', 200));
  // Downgrade: the subscription lapses, the way onSubscriptionDeleted does it.
  store.setTier('u1', 'byok');
  assert.equal(store.savedTier('u1'), 'byok');
  assert.equal(store.meteredThisMonth('u1').valueOf(), 300, 'every token of history survives');
  assert.equal(store.usageThisMonth('u1').runs, 2);
  db.close();
});

test('the meter reflects newly recorded usage immediately', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  assert.equal(store.meteredThisMonth('u1'), 0);
  store.recordUsage({
    id: 'use_1',
    userId: 'u1',
    runId: 'r1',
    model: 'a/b',
    metered: true,
    inputTokens: 40,
    outputTokens: 60,
  });
  assert.equal(store.meteredThisMonth('u1'), 100, 'no cache between the ledger and the meter');
  db.close();
});
