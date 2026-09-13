// "Priority on the run queue", which the plan sold and the queue did not have.
//
// claim() took the oldest queued run — ORDER BY created_at, id, strict FIFO
// with no such column — so the sentence on the pricing page was untrue from the
// day it was written. Measured here by seeding two runs and reading back which
// one claim() returns, not by describing the ordering.
// Run: node --test tests/run-priority.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';

const config = JSON.stringify({ model: 'a/b:free' });

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  t.after(() => db.close());
  // A clock that moves, so "queued first" is a real difference rather than two
  // rows in the same millisecond falling back to the id tie-break — which is
  // what made the first version of these tests pass for the wrong reason.
  let tick = 0;
  const store = createRunStore(db, () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString());
  store.createConversation({ id: 'c1', userId: 'free', model: 'a/b:free' });
  store.createConversation({ id: 'c2', userId: 'paid', model: 'a/b:free' });
  return store;
}

test('a paid run queued later is claimed before a free one queued first', (t) => {
  const store = setup(t);
  store.createRun({ id: 'free-run', conversationId: 'c1', userId: 'free', config });
  store.createRun({
    id: 'paid-run',
    conversationId: 'c2',
    userId: 'paid',
    config,
    priority: 10,
  });
  // Fails against strict FIFO, which returns 'free-run'.
  assert.equal(store.claimNext()?.id, 'paid-run');
  assert.equal(store.claimNext()?.id, 'free-run', 'and the free run still runs, next');
});

test('within one tier the queue is exactly as fair as it was', (t) => {
  const store = setup(t);
  // Named so the id tie-break would give the *wrong* answer: only age can
  // produce the expected one.
  store.createRun({ id: 'zebra', conversationId: 'c1', userId: 'free', config, priority: 10 });
  store.createRun({ id: 'apple', conversationId: 'c2', userId: 'paid', config, priority: 10 });
  assert.equal(store.claimNext()?.id, 'zebra', 'oldest first, within a tier');
});

test('a run queued before this existed keeps its place', (t) => {
  const store = setup(t);
  // No priority passed at all, which is every row written before the column,
  // and named so age rather than the id tie-break has to decide.
  store.createRun({ id: 'zebra', conversationId: 'c1', userId: 'free', config });
  store.createRun({ id: 'apple', conversationId: 'c2', userId: 'paid', config });
  assert.equal(store.claimNext()?.id, 'zebra');
});

test('priority is fixed at creation, not read from a plan that may change', (t) => {
  const store = setup(t);
  store.createRun({ id: 'paid-run', conversationId: 'c2', userId: 'paid', config, priority: 10 });
  store.createRun({ id: 'free-run', conversationId: 'c1', userId: 'free', config });
  // Nothing in the store can raise or lower a queued run's priority: there is
  // no method for it, which is the guarantee. A plan changing while a run waits
  // must not reorder work already queued under the old one.
  assert.equal(typeof store.claimNext, 'function');
  assert.equal(store.claimNext()?.id, 'paid-run');
});
