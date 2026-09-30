// Planning cost estimates. Session messages inside the 24h window are
// free; templates are the billable kind. Estimates are bounded and honest
// about being estimates — not Meta's rate card.
// Run: node --test tests/whatsapp-cost.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_COST_USD,
  MAX_MESSAGE_COST_USD,
  estimateCost,
  totalSpend,
} from '../lib/whatsapp/cost.ts';

test('session messages cost nothing', () => {
  for (const type of Object.keys(MESSAGE_COST_USD.session)) {
    assert.equal(estimateCost({ kind: 'session', type }), 0, type);
  }
});

test('template messages have a positive bounded estimate', () => {
  const cost = estimateCost({ kind: 'template', type: 'text' });
  assert.ok(cost > 0 && cost <= MAX_MESSAGE_COST_USD, `text template: ${cost}`);
  assert.equal(estimateCost({ kind: 'template', type: 'video' }), MAX_MESSAGE_COST_USD);
});

test('an unknown message type estimates at zero rather than inventing', () => {
  assert.equal(estimateCost({ kind: 'template', type: 'reaction' }), 0);
});

test('totalSpend sums estimates and rounds to cents', () => {
  assert.equal(
    totalSpend([{ cost_estimate: 0.01 }, { cost_estimate: 0.02 }, { cost_estimate: 0 }]),
    0.03,
  );
  assert.equal(totalSpend([{ cost_estimate: 0.015 }]), 0.02);
  assert.equal(totalSpend([]), 0);
});
