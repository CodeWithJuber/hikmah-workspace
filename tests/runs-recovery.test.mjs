// PR-09: the run failure/recovery contract.
//
// Four properties, each observable at the API boundary:
//
//  1. Reconnect with no duplicate output — a cancelled run announces its
//     termination exactly once, however the drive settles.
//  2. Write reconciliation — an interrupted attempt's events are pruned when
//     the run is requeued, so the next attempt replays no phantom output.
//  3. Visible partial result — a failed or cancelled run keeps what it had
//     actually produced, not a blank state.
//  4. Accurate cancelled state — a shutdown hands the run back to the queue;
//     it is never misrecorded as the owner stopping the run.
// Run: node --test tests/runs-recovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { createWorker } from '../lib/runs/worker.ts';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-recovery-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = createRunStore(db);
  store.createConversation({ id: 'c1', userId: 'u1' });
  return { store, db };
}

async function harness(t, drive, options = {}) {
  const { store, db } = await freshStore(t);
  const worker = createWorker({ db, drive, onError: () => {}, ...options });
  t.after(() => {
    void worker.stop();
  });
  const queue = (id) => store.createRun({ id, conversationId: 'c1', userId: 'u1', config: {} });
  return { worker, store, queue };
}

const deltas = (store, id) =>
  store
    .eventsAfter(id, -1)
    .filter((event) => event.payload?.type === 'text-delta')
    .map((event) => event.payload.delta);

const cancelledPhases = (store, id) =>
  store
    .eventsAfter(id, -1)
    .filter(
      (event) =>
        event.payload?.type === 'data-run-phase' && event.payload?.data?.phase === 'cancelled',
    );

// --- Write reconciliation --------------------------------------------------------

test('requeueing a crashed run prunes the interrupted attempt, not the cursor', async (t) => {
  // The crash shape: claimed, partially streamed, then the process died.
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.claimNext();
  for (let i = 0; i < 3; i += 1) store.appendEvent('r1', { i });

  // Simulate the process dying and starting again.
  store.requeueRunning();

  assert.equal(store.getRun('r1').status, 'queued');
  assert.deepEqual(
    store.eventsAfter('r1', -1),
    [],
    'the dead attempt replays nothing under the new one',
  );
  // The cursor only moves forward: a client holding a pre-crash cursor replays
  // exactly the new attempt's events — no gap from a reset, no repeat.
  assert.equal(store.appendEvent('r1', { i: 3 }), 3);
  assert.deepEqual(
    store.eventsAfter('r1', 2).map((event) => event.seq),
    [3],
  );
});

test('requeueing leaves a run that was never interrupted alone', async (t) => {
  // Precision pin: only an interrupted attempt is reconciled. A run that was
  // merely queued keeps its events — the denial marker a resume announces
  // lives exactly here.
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.appendEvent('r1', { type: 'data-run-phase', data: { phase: 'queued' } });
  store.appendEvent('r1', {
    type: 'data-run-phase',
    data: { phase: 'queued', reasonCode: 'denied' },
  });
  store.requeueRunning();
  assert.equal(store.eventsAfter('r1', -1).length, 2);
});

// --- No duplicate output ---------------------------------------------------------

test('a late-settling drive does not announce the cancellation twice', async (t) => {
  // The force-finish timer settles the run while the hung drive is still
  // unwinding; when the drive finally settles, the worker must not announce
  // 'cancelled' a second time — a reconnecting client would receive the
  // termination twice.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { worker, queue } = await harness(
    t,
    async ({ emit }) => {
      emit({ type: 'text-delta', delta: 'partial' });
      await gate;
      return { message: undefined };
    },
    { cancelGraceMs: 30 },
  );
  queue('r1');
  const ticked = worker.tick();
  await tick(20);
  assert.equal(worker.cancel('r1'), true);
  await tick(100); // past the grace period: the force-finish has settled it
  assert.equal(worker.store.getRun('r1').status, 'cancelled');
  release();
  await ticked;
  assert.equal(
    cancelledPhases(worker.store, 'r1').length,
    1,
    'exactly one cancelled phase chunk on the stream',
  );
});

// --- Accurate cancelled state ------------------------------------------------------

test('a shutdown hands the run back to the queue instead of recording a cancel', async (t) => {
  // SIGTERM aborts the provider call; the run was not stopped by its owner,
  // so 'cancelled' would be a lie — and a terminal one, stranding work the
  // next boot was meant to pick up.
  const { worker, queue } = await harness(
    t,
    ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  queue('r1');
  const ticked = worker.tick();
  await tick(20);
  assert.equal(worker.store.getRun('r1').status, 'running');

  await worker.stop();
  await ticked;

  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'queued', 'the next boot picks it up');
  assert.equal(run.reason_code, null, 'no outcome was recorded at all');
});

test('a shutdown prunes what the dying drive emitted while unwinding', async (t) => {
  // The drive does not listen to the abort: it unwinds on its own schedule,
  // like a provider call finishing after the signal fired. Anything it emits
  // between the requeue's prune and its own settle must not survive into the
  // next attempt's timeline.
  let unwind;
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'partial' });
    await new Promise((_, reject) => {
      unwind = () => {
        emit({ type: 'text-delta', delta: 'dying gasp' });
        reject(new Error('aborted'));
      };
    });
  });
  queue('r1');
  const ticked = worker.tick();
  await tick(20);
  await worker.stop(); // abort dispatched; requeue pruned 'partial'
  unwind(); // the drive's last emit while unwinding, then it settles
  await ticked;
  assert.deepEqual(
    worker.store.eventsAfter('r1', -1),
    [],
    'the next attempt starts from a clean timeline',
  );
  assert.equal(worker.store.getRun('r1').status, 'queued');
});

// --- Visible partial result ----------------------------------------------------------

test('a cancelled run keeps what it had actually produced', async (t) => {
  const { worker, queue } = await harness(t, async ({ emit, signal }) => {
    emit({ type: 'text-delta', delta: 'hel' });
    emit({ type: 'text-delta', delta: 'lo' });
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  queue('r1');
  const ticked = worker.tick();
  await tick(20);
  assert.equal(worker.cancel('r1'), true);
  await ticked;

  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.reason_code, 'cancelled', 'user-cancelled, not failed');
  assert.deepEqual(deltas(worker.store, 'r1'), ['hel', 'lo']);
  assert.equal(cancelledPhases(worker.store, 'r1').length, 1);
});

test('a failed run keeps what it had actually produced', async (t) => {
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'hel' });
    throw new Error('The provider rejected the request.');
  });
  queue('r1');
  await worker.tick();

  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /provider rejected/);
  assert.deepEqual(
    deltas(worker.store, 'r1'),
    ['hel'],
    'the partial answer replays to a reconnecting client',
  );
});
