// The worker loop. The point of these tests is the behaviour a user notices:
// closing the tab does not end the run, Stop really stops, a crash resumes, and
// a failure is recorded rather than swallowed.
// Run: node --test tests/runs-worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../lib/runs/worker.ts';

async function harness(t, drive) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-worker-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const worker = createWorker({ db, drive, onError: () => {} });
  worker.store.createConversation({ id: 'c1', userId: 'u1' });
  const queue = (id) =>
    worker.store.createRun({ id, conversationId: 'c1', userId: 'u1', config: {} });
  return { worker, db, queue };
}

test('a queued run is driven and its answer persisted', async (t) => {
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'Hello' });
    return { message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] } };
  });
  queue('r1');
  const handled = await worker.tick();
  assert.equal(handled.id, 'r1');
  assert.equal(worker.store.getRun('r1').status, 'done');

  // The answer is a row now, so a reload shows it without replaying anything.
  const [message] = worker.store.listMessages('c1');
  assert.equal(message.parts[0].text, 'Hello');
});

test('the resume buffer is dropped once the answer is a row', async (t) => {
  // Keeping both would show the answer twice on reconnect.
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'a' });
    emit({ type: 'text-delta', delta: 'b' });
    return { message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'ab' }] } };
  });
  queue('r1');
  await worker.tick();
  assert.equal(worker.store.eventsAfter('r1', -1).length, 0);
  assert.equal(worker.store.listMessages('c1').length, 1);
});

test('a subscriber sees chunks as they are produced', async (t) => {
  const seen = [];
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'one' });
    emit({ type: 'text-delta', delta: 'two' });
  });
  queue('r1');
  worker.bus.subscribe('r1', (event) => seen.push(event));
  await worker.tick();
  assert.deepEqual(
    seen.map((e) => e.payload.delta),
    ['one', 'two'],
  );
  assert.deepEqual(
    seen.map((e) => e.seq),
    [0, 1],
  );
});

test('a listener that throws does not stop the run or the other listeners', async (t) => {
  // A disconnected SSE response is the realistic case.
  const good = [];
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', delta: 'x' });
    emit({ type: 'text-delta', delta: 'y' });
    return { message: { id: 'm1', role: 'assistant', parts: [] } };
  });
  queue('r1');
  worker.bus.subscribe('r1', () => {
    throw new Error('client gone');
  });
  worker.bus.subscribe('r1', (event) => good.push(event));
  await worker.tick();
  assert.equal(worker.store.getRun('r1').status, 'done');
  assert.equal(good.length, 2);
});

test('a failing run records why, and does not take the worker down', async (t) => {
  const { worker, queue } = await harness(t, async () => {
    throw new Error('The provider rejected the request.');
  });
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /provider rejected/);

  // The next run still gets picked up.
  queue('r2');
  assert.equal((await worker.tick()).id, 'r2');
});

test('cancelling an in-flight run aborts it and marks it cancelled', async (t) => {
  let observed;
  const { worker, queue } = await harness(t, async ({ signal, run }) => {
    observed = signal;
    // Stand in for a provider stream that ends when the signal fires.
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(() => worker.cancel(run.id), 5);
    });
  });
  queue('r1');
  await worker.tick();
  assert.ok(observed.aborted, 'the driver must see the abort, so the provider call really stops');
  assert.equal(worker.store.getRun('r1').status, 'cancelled');
});

test('cancelling a run that has not started keeps the worker from ever running it', async (t) => {
  let drives = 0;
  const { worker, queue } = await harness(t, async () => {
    drives += 1;
  });
  queue('r1');
  assert.equal(worker.cancel('r1'), true);
  assert.equal(await worker.tick(), null);
  assert.equal(drives, 0);
  assert.equal(worker.store.getRun('r1').status, 'cancelled');
});

test('one run at a time: a second tick during a run does nothing', async (t) => {
  let active = 0;
  let overlap = false;
  const { worker, queue } = await harness(t, async () => {
    active += 1;
    if (active > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  });
  queue('r1');
  queue('r2');
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(overlap, false, 'the single worker must not run two at once');
});

test('a restart requeues work the previous process was running', async (t) => {
  const { worker, queue } = await harness(t, async () => {});
  queue('r1');
  worker.store.claimNext(); // the process dies here
  assert.equal(worker.store.getRun('r1').status, 'running');

  worker.start();
  assert.equal(worker.store.getRun('r1').status, 'queued', 'stranded work must come back');
  await worker.stop();
});

test('the answer keeps what it cost, so a reload can still say so', async (t) => {
  // Model and token usage arrive as the message's metadata. The worker used to
  // write null there, so a reloaded conversation had a transcript and no
  // figures — the composer's context meter had nothing to measure.
  const usage = { inputTokens: 812, outputTokens: 240, totalTokens: 1052 };
  const { worker, queue } = await harness(t, async () => ({
    message: {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Answer' }],
      metadata: { model: 'vendor/model', usage },
    },
  }));
  queue('r1');
  await worker.tick();

  const [stored] = worker.store.listMessages('c1');
  assert.deepEqual(stored.metadata, { model: 'vendor/model', usage });
});

test('an answer with nothing to report stores no metadata rather than null', async (t) => {
  const { worker, queue } = await harness(t, async () => ({
    message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] },
  }));
  queue('r1');
  await worker.tick();
  assert.equal(worker.store.listMessages('c1')[0].metadata, undefined);
});

test('a published plan reaches the durable log, so a reconnecting tab sees it', async (t) => {
  // update_plan used to put its steps in the tool result and nowhere else, so
  // a multi-step run showed a JSON payload where a checklist belonged, and a
  // reload showed nothing at all.
  const steps = [
    { step: 'Read the source', status: 'completed' },
    { step: 'Write the fix', status: 'in_progress' },
  ];
  const { worker, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'data-plan', id: 'plan', data: { steps } });
    return {
      message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Working.' }] },
    };
  });
  queue('r1');

  const seen = [];
  worker.bus.subscribe('r1', (event) => seen.push(event.payload));
  await worker.tick();

  const plan = seen.find((chunk) => chunk.type === 'data-plan');
  assert.ok(plan, 'the plan is fanned out to anyone watching');
  assert.deepEqual(plan.data.steps, steps);
});
