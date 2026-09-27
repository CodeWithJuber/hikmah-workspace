// The single run pipeline, against a real in-memory SQLite database. Never
// touches the dev database.
// Run: node --test tests/workflow-enqueue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createWorkflowStore } from '../lib/workflow/store.ts';
import { enqueueRun, enqueueCap, EnqueueFullError, DEFAULT_BUDGET } from '../lib/runs/enqueue.ts';
import { ARM_CALL_CAP, ARMS } from '../lib/workflow/arms.ts';
import { FEATURE_VERSION } from '../lib/workflow/policy.ts';

function harness(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(() => db.close());
  const store = createRunStore(db);
  const workflowStore = createWorkflowStore(db);
  store.createConversation({ id: 'c1', userId: 'u1' });
  return { db, store, workflowStore };
}

const keyed = {
  promptText: 'Explain quantum error correction.',
  taskCategory: 'chat',
  hasProviderKey: true,
  localFrame: null,
};

test('idempotency: same key returns the same run, one row', async (t) => {
  const { store, workflowStore } = harness(t);
  const first = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: { model: 'm' },
    idempotencyKey: 'idem_1',
    selection: keyed,
    store,
    workflowStore,
  });
  const second = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: { model: 'm' },
    idempotencyKey: 'idem_1',
    selection: keyed,
    store,
    workflowStore,
  });
  assert.equal(second.runId, first.runId);
  assert.equal(second.arm, first.arm);
  assert.deepEqual(second.selection, first.selection);
  assert.equal(store.countQueued(), 1);
  assert.ok(store.getRun(first.runId));
});

test('explicit arm override skips the policy but is stamped', async (t) => {
  const { store, workflowStore } = harness(t);
  const { runId, arm, selection } = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: { model: 'm', instructions: 'hi' },
    arm: 'decompose',
    selection: keyed,
    store,
    workflowStore,
  });
  assert.equal(arm, 'decompose');
  assert.deepEqual(selection, { overridden: true });
  const stored = JSON.parse(store.getRun(runId).config);
  // Additive: everything the caller built is still there.
  assert.equal(stored.model, 'm');
  assert.equal(stored.instructions, 'hi');
  assert.equal(stored.workflow.arm, 'decompose');
  assert.equal(stored.workflow.budget.maxCalls, ARM_CALL_CAP.decompose);
  // An override is not a sampled selection: nothing to log a propensity for.
  assert.equal(workflowStore.recentPropensities(10).length, 0);
});

test('ineligible arm override throws', async (t) => {
  const { store, workflowStore } = harness(t);
  assert.throws(
    () =>
      enqueueRun({
        userId: 'u1',
        conversationId: 'c1',
        config: {},
        arm: 'direct',
        // No provider key and no local frame: nothing is eligible.
        selection: {
          promptText: 'x',
          taskCategory: 'chat',
          hasProviderKey: false,
          localFrame: null,
        },
        store,
        workflowStore,
      }),
    /not eligible/,
  );
  assert.equal(store.countQueued(), 0);
});

test('at cap throws EnqueueFullError', async (t) => {
  const { store, workflowStore } = harness(t);
  const saved = process.env.HIKMAH_RUN_CONCURRENCY;
  process.env.HIKMAH_RUN_CONCURRENCY = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.HIKMAH_RUN_CONCURRENCY;
    else process.env.HIKMAH_RUN_CONCURRENCY = saved;
  });
  assert.equal(enqueueCap(), 1);
  enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: {},
    selection: keyed,
    store,
    workflowStore,
  });
  let error;
  try {
    enqueueRun({
      userId: 'u1',
      conversationId: 'c1',
      config: {},
      selection: keyed,
      store,
      workflowStore,
    });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof EnqueueFullError, 'expected EnqueueFullError');
  assert.match(error.message, /Too many runs/);
  assert.equal(error.active, 1);
  assert.equal(error.cap, 1);
  assert.equal(store.countQueued(), 1);
});

test('fallback prior: zero feedback selects exactly what the pipeline did before (direct)', async (t) => {
  const { store, workflowStore } = harness(t);
  const { arm, selection } = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: {},
    selection: keyed,
    store,
    workflowStore,
  });
  assert.equal(arm, 'direct');
  assert.ok(ARMS.includes(arm));
  assert.equal(selection.featureVersion, FEATURE_VERSION);
  // Epsilon is 0 and every arm scores the fallback 0: greedy, deterministic.
  assert.equal(selection.propensity, 1);
  assert.deepEqual(selection.scores, {
    direct: 0,
    'verify-repair': 0,
    decompose: 0,
    'explore-consensus': 0,
  });
});

test('budget is stamped on the config; caller overrides win', async (t) => {
  const { store, workflowStore } = harness(t);
  const { runId } = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: {},
    selection: keyed,
    budget: { maxTokens: 5000 },
    priority: 5,
    store,
    workflowStore,
  });
  const stored = JSON.parse(store.getRun(runId).config);
  assert.equal(stored.workflow.budget.maxCalls, ARM_CALL_CAP.direct);
  assert.equal(stored.workflow.budget.maxTokens, 5000);
  assert.equal(stored.workflow.budget.maxCost, DEFAULT_BUDGET.maxCost);
  assert.equal(stored.workflow.budget.deadlineMs, DEFAULT_BUDGET.deadlineMs);
  // Priority keeps its 0013 semantics: written from the caller tier.
  assert.equal(store.getRun(runId).priority, 5);
});

test('policy selection is propensity-logged for replay', async (t) => {
  const { store, workflowStore } = harness(t);
  const { runId, arm, selection } = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: {},
    selection: keyed,
    store,
    workflowStore,
  });
  const [row] = workflowStore.recentPropensities(5);
  assert.equal(row.runId, runId);
  assert.equal(row.arm, arm);
  assert.equal(row.propensity, selection.propensity);
  assert.equal(row.featureVersion, FEATURE_VERSION);
  // The full ArmScore array: the inspection view can see which arms were on
  // the fallback prior when this run was enqueued.
  assert.ok(Array.isArray(row.scores));
  assert.equal(row.scores.length, 4);
  assert.ok(row.scores.every((s) => s.isFallback === true && s.score === 0));
  assert.deepEqual(
    row.scores.map((s) => s.arm),
    ['direct', 'verify-repair', 'decompose', 'explore-consensus'],
  );
});

test('enqueue works without a workflow store (policy off, fallback arm)', async (t) => {
  const { store } = harness(t);
  const { arm } = enqueueRun({
    userId: 'u1',
    conversationId: 'c1',
    config: {},
    selection: keyed,
    store,
  });
  assert.equal(arm, 'direct');
});
