// Persisting the answer after a run has already been paused once.
//
// The SDK reuses the id of the last assistant message in the transcript when it
// starts a stream: createAgentUIStream defaults `originalMessages` to whatever
// was passed as `uiMessages`, and a resumed run's transcript ends with the
// paused assistant row. So the message the worker gets back on turn two carries
// the SAME id as a row that already exists.
//
// tests/runs-approval.test.mjs drives the same path but has its fake return a
// fresh id ('m-final'), which is the one thing the real SDK does not do. That is
// why it passed while every approval on the deployed site failed with
// "UNIQUE constraint failed: messages.id" and lost the answer.
// Run: node --test tests/runs-resume-persist.test.mjs
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

function queue(store, id = 'run-1') {
  if (!store.listMessages('conv-1').length) {
    store.createConversation({ id: 'conv-1', userId: 'user-1', model: config.model });
    store.appendMessage('conv-1', {
      id: 'm-user',
      role: 'user',
      parts: [{ type: 'text', text: 'delete the old logs' }],
    });
  }
  store.createRun({ id, conversationId: 'conv-1', userId: 'user-1', config });
  return id;
}

/** The paused turn: a tool waiting on a decision. */
const asking = {
  id: 'm-assistant',
  role: 'assistant',
  parts: [
    {
      type: 'tool-bash',
      toolCallId: 'c1',
      state: 'approval-requested',
      input: { command: 'rm -rf /var/log/old', description: 'Delete the old logs' },
    },
  ],
};

/** What the SDK actually returns on the resumed turn: the same id, now settled
 * and with the answer appended. */
const finished = {
  id: 'm-assistant',
  role: 'assistant',
  parts: [
    { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', output: 'removed 12 files' },
    { type: 'text', text: 'Removed twelve files.' },
  ],
  metadata: { model: 'a/b:free', usage: { inputTokens: 20, outputTokens: 5 } },
};

const answered = (approved) => ({
  ...asking,
  parts: [{ ...asking.parts[0], state: 'approval-responded', approved }],
});

test('a resumed run keeps the answer instead of colliding with its own row', async (t) => {
  let turn = 0;
  const worker = setup(t, async () => {
    turn += 1;
    return turn === 1 ? { message: asking, awaitingApproval: true } : { message: finished };
  });
  const id = queue(worker.store);

  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'waiting_approval');

  worker.store.replaceMessage('conv-1', answered(true));
  worker.store.requeueApproved(id);
  await worker.tick();

  const run = worker.store.getRun(id);
  assert.equal(run.status, 'done', run.error ?? '');
  assert.equal(run.error, null, 'and no error is recorded');

  // The answer survives, in place, rather than being lost to a failed insert.
  const messages = worker.store.listMessages('conv-1');
  assert.equal(messages.length, 2, 'the answer replaces the paused turn, it does not duplicate it');
  const last = messages.at(-1);
  assert.equal(last.id, 'm-assistant');
  assert.match(last.parts.at(-1).text, /Removed twelve files/);
  assert.equal(last.parts[0].state, 'output-available', 'and the tool call is settled');
  assert.equal(last.metadata.usage.outputTokens, 5, 'with what it cost');
});

test('an internal fault is not reported to the person in database language', async (t) => {
  const worker = setup(t, async () => {
    throw Error('UNIQUE constraint failed: messages.id');
  });
  const id = queue(worker.store);
  await worker.tick();

  const run = worker.store.getRun(id);
  assert.equal(run.status, 'failed');
  assert.doesNotMatch(run.error, /UNIQUE|constraint|sqlite/i, 'the raw fault stays in the log');
  assert.match(
    run.error,
    /again|support|wrong/i,
    'and the person is told something they can act on',
  );
});

test('a provider failure still reaches the person in the provider’s own words', async (t) => {
  // The distinction that matters: a 401 or "model not available" is exactly what
  // someone needs to read, and this must not be swallowed along with the noise.
  const worker = setup(t, async () => {
    throw Error('This endpoint requires a paid account: deepseek/deepseek-chat is not free.');
  });
  const id = queue(worker.store);
  await worker.tick();
  assert.match(worker.store.getRun(id).error, /paid account/);
});

test('two answers for one paused turn settle it once', async (t) => {
  // A second tab answering the same question must not append a second copy.
  let turn = 0;
  const worker = setup(t, async () => {
    turn += 1;
    return turn === 1 ? { message: asking, awaitingApproval: true } : { message: finished };
  });
  const id = queue(worker.store);
  await worker.tick();

  worker.store.replaceMessage('conv-1', answered(true));
  assert.equal(worker.store.requeueApproved(id), true);
  assert.equal(worker.store.requeueApproved(id), false, 'the second answer is absorbed');
  await worker.tick();
  assert.equal(worker.store.listMessages('conv-1').length, 2);
});

test('a message id belonging to another conversation is never adopted', async (t) => {
  // saveAssistantMessage updates in place only when the row is this
  // conversation's. Otherwise a collision across threads would move a message.
  const worker = setup(t, async () => ({ message: finished }));
  worker.store.createConversation({ id: 'conv-2', userId: 'user-1', model: config.model });
  worker.store.appendMessage('conv-2', {
    id: 'm-assistant',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Belongs to the other thread.' }],
  });
  queue(worker.store);
  await worker.tick();

  assert.match(
    worker.store.listMessages('conv-2').at(-1).parts[0].text,
    /other thread/,
    'the other conversation is untouched',
  );
});
