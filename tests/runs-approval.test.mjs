// A run that stops to ask the owner something must survive the tab that asked.
// These cover the durable half: the worker pausing instead of finishing, and
// the answer resuming that run rather than starting another.
// Run: node --test tests/runs-approval.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../lib/runs/worker.ts';

function setup(t, drive) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  const worker = createWorker({ db, drive });
  t.after(() => {
    void worker.stop();
    db.close();
  });
  return worker;
}

const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'a/b:free',
  freeOnly: true,
  apiKey: 'k',
  instructions: 'test',
};

/** Queue one run over a conversation with a single user message. */
function queue(store, { id = 'run-1', conversationId = 'conv-1' } = {}) {
  if (!store.listMessages(conversationId).length) {
    store.createConversation({ id: conversationId, userId: 'user-1', model: config.model });
    store.appendMessage(conversationId, {
      id: 'm-user',
      role: 'user',
      parts: [{ type: 'text', text: 'restart nginx' }],
    });
  }
  store.createRun({ id, conversationId, userId: 'user-1', config });
  return id;
}

const asking = {
  id: 'm-assistant',
  role: 'assistant',
  parts: [
    {
      type: 'tool-ssh_exec',
      toolCallId: 'c1',
      state: 'approval-requested',
      input: { host_id: 'h1', command: 'systemctl restart nginx' },
      approval: { id: 'a1' },
    },
  ],
};

const answered = (approved) => ({
  ...asking,
  parts: asking.parts.map((part) => ({
    ...part,
    state: 'approval-responded',
    approval: { id: 'a1', approved },
  })),
});

test('a run that stops to ask is waiting, not done', async (t) => {
  // Marking it done would mean the answer arrives with nothing left to resume.
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'waiting_approval');
  assert.equal(worker.store.getRun(id).ended_at, null, 'a waiting run has not ended');
});

test('a run that simply finishes is still done', async (t) => {
  const worker = setup(t, async () => ({
    message: { id: 'm-a', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
  }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'done');
});

test('the question is persisted, so a reload can render the card', async (t) => {
  // The whole point of pausing durably: the tab that asked may be gone.
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  queue(worker.store);
  await worker.tick();
  const stored = worker.store.listMessages('conv-1').at(-1);
  assert.equal(stored.role, 'assistant');
  assert.equal(stored.parts[0].state, 'approval-requested');
});

test('a waiting run still counts as active, so nothing else answers the thread', async (t) => {
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.activeForConversation('conv-1'), id);
  assert.equal(worker.store.countActive('user-1'), 1);
});

test('answering releases the same run rather than starting another', async (t) => {
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  const id = queue(worker.store);
  await worker.tick();

  assert.equal(worker.store.requeueApproved(id), true);
  assert.equal(worker.store.getRun(id).status, 'queued');
  assert.equal(worker.store.activeForConversation('conv-1'), id, 'still the same run');
});

test('a second answer to the same question does nothing', async (t) => {
  // Two tabs showing the same card, or a double click. The second must not
  // queue a duplicate run over a conversation that already has one.
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.requeueApproved(id), true);
  assert.equal(worker.store.requeueApproved(id), false, 'the run has already moved on');
});

test('a running or finished run cannot be requeued by an answer', async (t) => {
  const worker = setup(t, async () => ({
    message: { id: 'm-a', role: 'assistant', parts: [] },
  }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'done');
  assert.equal(worker.store.requeueApproved(id), false, 'a finished run stays finished');
});

test('the answered message replaces the question instead of piling up beside it', async (t) => {
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  queue(worker.store);
  await worker.tick();
  const before = worker.store.listMessages('conv-1').length;

  assert.equal(worker.store.replaceMessage('conv-1', answered(true)), true);
  const after = worker.store.listMessages('conv-1');
  assert.equal(after.length, before, 'the conversation must not hold both copies');
  assert.equal(after.at(-1).parts[0].state, 'approval-responded');
  assert.equal(after.at(-1).parts[0].approval.approved, true);
});

test('a message belonging to another conversation is not touched', async (t) => {
  const worker = setup(t, async () => ({ message: asking, awaitingApproval: true }));
  queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.replaceMessage('conv-other', answered(true)), false);
  assert.equal(worker.store.listMessages('conv-1').at(-1).parts[0].state, 'approval-requested');
});

test('the resumed run drives again and can finish', async (t) => {
  // End to end through the worker: ask, answer, resume, done.
  let turn = 0;
  const worker = setup(t, async () => {
    turn += 1;
    return turn === 1
      ? { message: asking, awaitingApproval: true }
      : {
          message: {
            id: 'm-final',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Restarted.' }],
          },
        };
  });
  const id = queue(worker.store);

  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'waiting_approval');

  worker.store.replaceMessage('conv-1', answered(true));
  worker.store.requeueApproved(id);
  await worker.tick();

  assert.equal(worker.store.getRun(id).status, 'done');
  assert.equal(worker.store.activeForConversation('conv-1'), null, 'the thread is free again');
  assert.match(worker.store.listMessages('conv-1').at(-1).parts[0].text, /Restarted/);
});

test('the answer is named on the first chunk, by the id the worker stores it under', async () => {
  // Answering an approval on a live stream re-sends the message by id. The
  // browser's id has to be the stored one, and a fresh turn's `start` chunk
  // names none — so the driver names it.
  const { answerIdFor, nameAnswer } = await import('../lib/runs/answer-id.ts');
  assert.deepEqual(nameAnswer({ type: 'start' }, 'run_1'), {
    type: 'start',
    messageId: answerIdFor('run_1'),
  });
  assert.deepEqual(
    nameAnswer({ type: 'start', messageId: 'run_1-answer' }, 'run_1'),
    { type: 'start', messageId: 'run_1-answer' },
    'a resumed turn already names the stored message',
  );
  assert.deepEqual(nameAnswer({ type: 'text-delta', delta: 'x' }, 'run_1'), {
    type: 'text-delta',
    delta: 'x',
  });
});
