// The price a plan card prints.
//
// A public audit of the live site found the paid card carrying no price at all
// — the page asks whose key the models run on and then would not say what the
// answer costs. The free plan's zero is a fact on every deployment; the paid
// plan's amount lives in Stripe, so the deployment names it the same way it
// already names the price id, and an unnamed one says so rather than showing a
// gap.
// Run: node --test tests/plan-price.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
// The catalogue itself, not the typed re-export: that one reaches for the
// '@/server' alias, which only Next and tsc resolve.
import { PLANS, priceLabelFor } from '../server/plans.mjs';
import { contactAddress } from '../lib/marketing/contact.ts';

const planFor = (id) => {
  const plan = PLANS.find((p) => p.id === id);
  assert.ok(plan, `no ${id} plan in the catalogue`);
  return plan;
};

test('the free plan states its zero without any configuration', () => {
  const free = planFor('free');
  assert.equal(priceLabelFor(free), '$0');
  assert.match(free.priceNote ?? '', /provider/i, 'says where the money does go');
});

test('a paid plan prints the amount the deployment named, and nothing when it named none', () => {
  const pro = planFor('pro');
  const previous = process.env[pro.priceEnv];
  try {
    delete process.env[pro.priceEnv];
    assert.equal(priceLabelFor(pro), '', 'unset means the card falls back, never a blank price');
    process.env[pro.priceEnv] = '  $19 a month  ';
    assert.equal(priceLabelFor(pro), '$19 a month', 'trimmed');
    process.env[pro.priceEnv] = 'x'.repeat(200);
    assert.equal(priceLabelFor(pro).length, 40, 'bounded, so a stray value cannot break the card');
  } finally {
    if (previous === undefined) delete process.env[pro.priceEnv];
    else process.env[pro.priceEnv] = previous;
  }
});

test('every plan the catalogue offers can be asked for a price without throwing', () => {
  for (const plan of PLANS) assert.equal(typeof priceLabelFor(plan), 'string', plan.id);
});

test('the legal pages print a contact only when the deployment gave a real one', () => {
  const previous = process.env.HIKMAH_CONTACT_EMAIL;
  try {
    delete process.env.HIKMAH_CONTACT_EMAIL;
    assert.equal(contactAddress(), '', 'no address is invented');
    process.env.HIKMAH_CONTACT_EMAIL = 'not-an-address';
    assert.equal(contactAddress(), '', 'and a value that is not one is not printed');
    process.env.HIKMAH_CONTACT_EMAIL = ' hello@example.test ';
    assert.equal(contactAddress(), 'hello@example.test');
  } finally {
    if (previous === undefined) delete process.env.HIKMAH_CONTACT_EMAIL;
    else process.env.HIKMAH_CONTACT_EMAIL = previous;
  }
});
