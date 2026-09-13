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

async function harness(t, drive, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-worker-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const worker = createWorker({ db, drive, onError: () => {}, ...options });
  worker.store.createConversation({ id: 'c1', userId: 'u1' });
  const queue = (id, config = {}, priority = 0) =>
    worker.store.createRun({ id, conversationId: 'c1', userId: 'u1', config, priority });
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

test('at most `concurrency` runs at once, and one by default', async (t) => {
  // One `busy` flag meant one run process-wide: a long background task would
  // have frozen every live chat for its whole duration. The worker now runs up
  // to a count, and a tick past it does nothing.
  let active = 0;
  let peak = 0;
  const { worker, queue } = await harness(t, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
  });
  queue('r1');
  queue('r2');
  queue('r3');
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(peak, 1, 'the default is still one at a time');
});

test('two chats overlap at concurrency 2, and a third waits', async (t) => {
  let active = 0;
  let peak = 0;
  const { worker, queue } = await harness(
    t,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    },
    { concurrency: 2 },
  );
  queue('r1');
  queue('r2');
  queue('r3');
  const handled = await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(peak, 2, 'two ran together');
  assert.equal(handled.filter(Boolean).length, 2, 'the third tick found no free slot');
  assert.equal(worker.store.getRun('r3').status, 'queued', 'and left the third for later');
});

test('the last free slot is kept for a chat: a second task waits while a task runs', async (t) => {
  // Tasks are unattended and long. Two of them at concurrency 2 would fill the
  // worker and every chat would queue behind them — the freeze the count was
  // meant to end, back through another door.
  const driven = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const { worker, queue } = await harness(
    t,
    async ({ run }) => {
      driven.push(run.id);
      await gate;
    },
    { concurrency: 2 },
  );
  queue('task1', { task: { kind: 'learn', brief: 'x' } });
  queue('task2', { task: { kind: 'learn', brief: 'y' } });
  const first = worker.tick();
  const second = worker.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(driven, ['task1'], 'one task runs; the second is not claimed');
  assert.equal(worker.store.getRun('task2').status, 'queued');
  assert.equal(worker.active, 1);

  // A chat arriving now takes the reserved slot straight away.
  queue('chat1');
  const third = worker.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(driven, ['task1', 'chat1'], 'the chat did not wait behind the task');
  release();
  await Promise.all([first, second, third]);
  // With the task finished, the second task is claimable on the next tick.
  await worker.tick();
  assert.deepEqual(driven, ['task1', 'chat1', 'task2']);
});

test('a task is claimed after every chat, whatever their priority', async (t) => {
  const driven = [];
  const { worker, queue } = await harness(t, async ({ run }) => {
    driven.push(run.id);
  });
  queue('task1', { task: { kind: 'learn', brief: 'x' } }, -1);
  queue('chat1', {}, 0);
  await worker.tick();
  await worker.tick();
  assert.deepEqual(driven, ['chat1', 'task1']);
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
