// A cancelled run must settle even when its driver ignores the abort signal.
// Before this, the abort was the only mechanism: a drive hung in an await
// that never listens to the signal left the run marked running forever, and
// the sidebar's "Still answering" badge survived both the stop button and a
// page reload. The worker now force-finishes after a grace period, and the
// store's finish cannot overwrite a terminal state.
// Run: node --test tests/runs-cancel-force.test.mjs
import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../lib/runs/worker.ts';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t, drive, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  const worker = createWorker({ db, drive, cancelGraceMs: 40, ...options });
  t.after(() => {
    void worker.stop();
    db.close();
  });
  return worker;
}

function queue(store) {
  const conversationId = 'conv-1';
  store.createConversation({ id: conversationId, userId: 'user-1', model: 'a/b:free' });
  store.appendMessage(conversationId, {
    id: 'm-user',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  });
  store.createRun({
    id: 'run-1',
    conversationId,
    userId: 'user-1',
    config: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
  });
  return 'run-1';
}

/** The badge's source of truth: the conversations list joins active_run_id to
 * any non-terminal run row. Reproduce the exact predicate here. */
function badgeShows(store) {
  return store
    .listConversations('user-1', 100)
    .some(
      (row) => row.id === 'conv-1' && (row.run_status === 'queued' || row.run_status === 'running'),
    );
}

test('a driver that ignores the abort is force-finished as cancelled', async (t) => {
  // Never settles and never listens to the signal: the hung-provider shape.
  const worker = setup(t, () => new Promise(() => {}));
  const id = queue(worker.store);
  const ticked = worker.tick();
  await tick(20); // let the claim land so the run is in the running map
  assert.equal(worker.store.getRun(id).status, 'running');
  assert.equal(badgeShows(worker.store), true, 'badge shows while the run is stuck');

  assert.equal(worker.cancel(id), true);
  await tick(120); // past the test grace period
  assert.equal(worker.store.getRun(id).status, 'cancelled');
  assert.equal(badgeShows(worker.store), false, 'badge clears after the forced finish');
  // The hung drive itself never settles — that is the shape under test — so
  // the tick is deliberately not awaited. stop() in t.after aborts it.
  void ticked.catch(() => {});
});

test('a late-settling drive cannot overwrite the forced outcome', async (t) => {
  const worker = setup(t, async () => ({ message: undefined }));
  const id = queue(worker.store);
  worker.store.finish(id, 'cancelled');
  // The drive finally returns and the worker records done — the guard holds.
  worker.store.finish(id, 'done');
  assert.equal(worker.store.getRun(id).status, 'cancelled');
  assert.equal(badgeShows(worker.store), false);
});

test('a normal cancel still settles through the driver when it listens', async (t) => {
  let aborted = false;
  const worker = setup(
    t,
    ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    { cancelGraceMs: 10_000 },
  );
  const id = queue(worker.store);
  const ticked = worker.tick();
  await tick(20);
  assert.equal(worker.cancel(id), true);
  await ticked;
  assert.equal(aborted, true);
  assert.equal(worker.store.getRun(id).status, 'cancelled');
  assert.equal(badgeShows(worker.store), false);
});
