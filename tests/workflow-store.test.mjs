// Persistence for the v5 control layer's learned state, against a real
// in-memory SQLite database. Never touches the dev database.
// Run: node --test tests/workflow-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createWorkflowStore } from '../lib/workflow/store.ts';
import { initialPolicyState, FEATURE_DIM } from '../lib/workflow/policy.ts';

function freshWorkflowStore(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  return createWorkflowStore(db);
}

/** One-hot feature vector: the update's effect is readable by position. */
const oneHot = () => new Array(FEATURE_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0));

const feedback = (id, arm = 'direct', quality = 0.8) => ({
  id,
  arm,
  x: oneHot(),
  quality,
  cost: 0,
  budget: 1,
  latencyMs: 0,
  deadlineMs: 1,
});

test('policy state round-trips through SQLite', async (t) => {
  const store = freshWorkflowStore(t);
  // Empty table: the fallback prior, identical to a fresh initialPolicyState.
  assert.deepEqual(store.loadPolicyState(), initialPolicyState());

  const before = store.loadPolicyState();
  const { applied, duplicate } = store.recordFeedback(feedback('fb_1'));
  assert.equal(applied, true);
  assert.equal(duplicate, false);

  const after = store.loadPolicyState();
  // r = q = 0.8 (no cost, no latency): b_direct moved by w·x·r on position 0.
  assert.equal(after.arms.direct.b[0], 0.8);
  assert.ok(after.arms.direct.b.slice(1).every((v) => v === 0));
  assert.deepEqual(after.arms['verify-repair'].b, before.arms['verify-repair'].b);
  // A_direct gained w·x·xᵀ on the (0,0) entry only.
  assert.equal(after.arms.direct.A[0][0], before.arms.direct.A[0][0] + 1);
  assert.equal(after.version, before.version);
});

test('duplicate feedback ids are idempotent', async (t) => {
  const store = freshWorkflowStore(t);
  const fb = feedback('fb_dup', 'direct', 0.5);
  assert.deepEqual(store.recordFeedback(fb), { applied: true, duplicate: false });
  const once = store.loadPolicyState();
  assert.deepEqual(store.recordFeedback(fb), { applied: false, duplicate: true });
  // The second application changed nothing.
  assert.deepEqual(store.loadPolicyState(), once);
  // And the log holds exactly one row for the id.
  assert.equal(store.recentUpdates(10).length, 1);
});

test('missing quality is not success: no update, but the id is consumed', async (t) => {
  const store = freshWorkflowStore(t);
  const before = store.loadPolicyState();
  assert.deepEqual(store.recordFeedback(feedback('fb_null', 'direct', null)), {
    applied: false,
    duplicate: false,
  });
  assert.deepEqual(store.loadPolicyState(), before);
  // Seen and recorded as not-applicable: a replay must not reconsider it.
  assert.deepEqual(store.recordFeedback(feedback('fb_null', 'direct', 0.9)), {
    applied: false,
    duplicate: true,
  });
  assert.deepEqual(store.loadPolicyState(), before);
});

test('outcome counts accumulate per (state, arm, outcome)', async (t) => {
  const store = freshWorkflowStore(t);
  assert.deepEqual(store.loadOutcomeCounts(), []);
  store.recordOutcome('chat|known|evidence|none', 'direct', 'verified_success');
  store.recordOutcome('chat|known|evidence|none', 'direct', 'verified_success');
  store.recordOutcome('chat|known|evidence|none', 'direct', 'verified_failure');
  store.recordOutcome('chat|known|evidence|none', 'decompose', 'verified_success');
  const rows = store.loadOutcomeCounts();
  const get = (arm, outcome) =>
    rows.find(
      (r) => r.stateKey === 'chat|known|evidence|none' && r.arm === arm && r.outcome === outcome,
    )?.count ?? 0;
  assert.equal(get('direct', 'verified_success'), 2);
  assert.equal(get('direct', 'verified_failure'), 1);
  assert.equal(get('decompose', 'verified_success'), 1);
  assert.equal(rows.length, 3);
});

test('propensity log keeps the exact selection audit trail', async (t) => {
  const store = freshWorkflowStore(t);
  const scores = [
    { arm: 'direct', score: 0, isFallback: true },
    { arm: 'verify-repair', score: 0, isFallback: true },
  ];
  store.logPropensity('run_1', 'direct', 1, 1, scores);
  const [row] = store.recentPropensities(5);
  assert.equal(row.runId, 'run_1');
  assert.equal(row.arm, 'direct');
  assert.equal(row.propensity, 1);
  assert.equal(row.featureVersion, 1);
  assert.deepEqual(row.scores, scores);
  assert.ok(typeof row.createdAt === 'string');
});

test('recent updates surface the reward breakdown for the inspection view', async (t) => {
  const store = freshWorkflowStore(t);
  store.recordFeedback(feedback('fb_a', 'decompose', 0.2));
  store.recordFeedback(feedback('fb_b', 'direct', 0.9));
  const updates = store.recentUpdates(10);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((u) => u.feedbackId).sort(), ['fb_a', 'fb_b']);
  const direct = updates.find((u) => u.feedbackId === 'fb_b');
  assert.equal(direct.arm, 'direct');
  // Quality/cost/latency stay visible separately — never one opaque number.
  assert.deepEqual(direct.reward, { total: 0.9, quality: 0.9, cost: 0, latency: 0 });
});
