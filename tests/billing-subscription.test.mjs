// Turning a Stripe subscription into a tier.
//
// The plugin owns the subscription rows in auth.sqlite and the run route reads
// user_tiers in workspace.sqlite, so this mapping is the seam between the two.
// Getting it wrong in either direction is expensive: too generous and the
// deployment pays for someone who is not paying, too mean and a paying customer
// is refused.
// Run: node --test tests/billing-subscription.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { subscriptionUserId, tierForSubscription } from '../server/billing-sync.mjs';
import { PLANS, priceIdFor, stripePlans } from '../server/plans.mjs';

test('a trial counts as paid, because the point of a trial is that it works', () => {
  assert.equal(tierForSubscription({ status: 'trialing', plan: 'pro' }), 'managed');
  assert.equal(tierForSubscription({ status: 'active', plan: 'pro' }), 'managed');
});

test('everything else falls back to the free tier rather than staying paid', () => {
  // past_due is deliberately absent here: PR-15 keeps the paid tier while
  // Stripe retries the card (see billing-clarity.test.mjs), so a failed
  // renewal degrades gracefully instead of locking the person out.
  for (const status of ['canceled', 'unpaid', 'incomplete', 'paused', undefined])
    assert.equal(tierForSubscription({ status, plan: 'pro' }), 'byok', String(status));
  assert.equal(tierForSubscription(undefined), 'byok');
  assert.equal(tierForSubscription(null), 'byok');
});

test('an unknown plan name does not grant the managed tier', () => {
  // A price added in the Stripe dashboard but not here must not silently become
  // an entitlement this deployment has never defined.
  assert.equal(tierForSubscription({ status: 'active', plan: 'enterprise' }), 'byok');
  assert.equal(tierForSubscription({ status: 'active', plan: 'free' }), 'byok');
});

test('the subscription is attributed to a person, by reference id first', () => {
  assert.equal(subscriptionUserId({ referenceId: 'u1', userId: 'u2' }), 'u1');
  assert.equal(subscriptionUserId({ userId: 'u2' }), 'u2');
  assert.equal(subscriptionUserId({}), '');
  assert.equal(subscriptionUserId(undefined), '');
});

test('only priced, managed plans are handed to Stripe', () => {
  const previous = { ...process.env };
  try {
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    assert.deepEqual(stripePlans(), [], 'a plan with no price id cannot be bought');

    process.env.STRIPE_PRICE_PRO = 'price_pro';
    const [pro] = stripePlans();
    assert.equal(pro.name, 'pro');
    assert.equal(pro.priceId, 'price_pro');
    assert.equal(pro.freeTrial.days, 14);
    assert.equal(pro.annualDiscountPriceId, undefined, 'no annual price, no annual option');

    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_year';
    assert.equal(stripePlans()[0].annualDiscountPriceId, 'price_pro_year');

    // The free tier is never sent: it has no price and buying it would mean
    // charging someone for using their own key.
    assert.ok(!stripePlans().some((plan) => plan.name === 'free'));
  } finally {
    for (const key of ['STRIPE_PRICE_PRO', 'STRIPE_PRICE_PRO_ANNUAL'])
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
});

test('the catalogue and the entitlements agree about what a plan includes', () => {
  const free = PLANS.find((plan) => plan.id === 'free');
  const pro = PLANS.find((plan) => plan.id === 'pro');
  assert.equal(free.tier, 'byok');
  assert.equal(free.monthlyTokenCap, null, 'a plan on your own key has nothing to cap');
  assert.equal(priceIdFor(free), '', 'and nothing to charge for');
  assert.equal(pro.tier, 'managed');
  assert.ok(pro.monthlyTokenCap > 0, 'a plan on our key must have a limit');
});

test('the tier written by a webhook is the tier the run route reads', () => {
  // The two halves of the seam, against the real schema: the column the sync
  // writes and the column entitlements reads are the same column.
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  db.prepare('INSERT INTO user_tiers (user_id, tier, updated_at) VALUES (?, ?, ?)').run(
    'u1',
    tierForSubscription({ status: 'trialing', plan: 'pro' }),
    new Date().toISOString(),
  );
  assert.equal(
    db.prepare('SELECT tier FROM user_tiers WHERE user_id = ?').get('u1').tier,
    'managed',
  );
  db.close();
});
