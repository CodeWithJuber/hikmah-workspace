// A run that stops to ask a question, rather than to ask permission.
//
// The two look alike and are not the same. An approval carries yes or no; a
// question carries what the person said, which is why `ask_user` is a tool with
// no `execute` rather than a gated one. These cover the durable half: the
// worker pausing on the unanswered call, and the answer resuming that run
// instead of starting another over the same conversation.
// Run: node --test tests/runs-question.test.mjs
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

function queue(store, { id = 'run-1', conversationId = 'conv-1' } = {}) {
  if (!store.listMessages(conversationId).length) {
    store.createConversation({ id: conversationId, userId: 'user-1', model: config.model });
    store.appendMessage(conversationId, {
      id: 'm-user',
      role: 'user',
      parts: [{ type: 'text', text: 'tidy up the config' }],
    });
  }
  store.createRun({ id, conversationId, userId: 'user-1', config });
  return id;
}

/** What the fold produces when the model called ask_user and stopped. */
const asking = {
  id: 'm-assistant',
  role: 'assistant',
  parts: [
    {
      type: 'tool-ask_user',
      toolCallId: 'q1',
      state: 'input-available',
      input: { question: 'Which config did you mean?', options: ['nginx', 'caddy'] },
    },
  ],
};

test('a run that stops to ask a question is waiting, not done', async (t) => {
  // Finishing here would mean the answer arrives with nothing left to resume,
  // and the person would have to repeat themselves to a conversation that had
  // already moved on.
  const worker = setup(t, async () => ({ message: asking, awaitingClient: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'waiting_client');
  assert.equal(worker.store.getRun(id).ended_at, null, 'a waiting run has not ended');
});

test('a paused question keeps the conversation occupied', async (t) => {
  // Otherwise the next message starts a second run over the same conversation
  // and two answers race to write the same transcript.
  const worker = setup(t, async () => ({ message: asking, awaitingClient: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.activeForConversation('conv-1'), id);
  assert.equal(worker.store.countActive('user-1'), 1);
});

test('the answer resumes that run, exactly once', async (t) => {
  const worker = setup(t, async () => ({ message: asking, awaitingClient: true }));
  const id = queue(worker.store);
  await worker.tick();

  assert.equal(worker.store.requeueAnswered(id), true);
  assert.equal(worker.store.getRun(id).status, 'queued');
  // A second tab, or a double click. The run has already moved on, so the
  // duplicate is absorbed rather than starting the work twice.
  assert.equal(worker.store.requeueAnswered(id), false);
});

test('an approval cannot release a run that is waiting on an answer', async (t) => {
  // The two pauses are different states and a client that confuses them has
  // lost track of the run. It should release nothing.
  const worker = setup(t, async () => ({ message: asking, awaitingClient: true }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.requeueApproved(id), false);
  assert.equal(worker.store.getRun(id).status, 'waiting_client');
});

test('the question is a row, so a reload still shows it', async (t) => {
  // The tab that asked may be gone. The part has to be persisted like any
  // other, or the run waits for an answer to a question nobody can see.
  const worker = setup(t, async () => ({ message: asking, awaitingClient: true }));
  queue(worker.store);
  await worker.tick();
  const stored = worker.store.listMessages('conv-1').at(-1);
  assert.equal(stored.role, 'assistant');
  assert.equal(stored.parts[0].type, 'tool-ask_user');
  assert.equal(stored.parts[0].state, 'input-available');
  assert.equal(stored.parts[0].input.question, 'Which config did you mean?');
});

test('a run that answers its own question is still done', async (t) => {
  // The pause is specific to a call left unanswered. A completed ask_user must
  // not strand the run.
  const worker = setup(t, async () => ({
    message: {
      id: 'm-a',
      role: 'assistant',
      parts: [
        { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-available', output: 'nginx' },
        { type: 'text', text: 'Tidied the nginx config.' },
      ],
    },
  }));
  const id = queue(worker.store);
  await worker.tick();
  assert.equal(worker.store.getRun(id).status, 'done');
});

// --- Which reply releases which pause -----------------------------------

const { releases, hasAnsweredQuestion } = await import('../lib/runs/resume.ts');

const question = (state, extra = {}) => ({
  role: 'assistant',
  parts: [{ type: 'tool-ask_user', toolCallId: 'q1', state, ...extra }],
});
const approval = (state) => ({
  role: 'assistant',
  parts: [{ type: 'tool-ssh_exec', toolCallId: 'c1', state, approval: { id: 'a1' } }],
});

test('an answer releases a run waiting on an answer', () => {
  assert.equal(releases('waiting_client', question('output-available')), 'answer');
});

test('an approval releases a run waiting on an approval', () => {
  assert.equal(releases('waiting_approval', approval('approval-responded')), 'approval');
});

test('neither reply releases the other kind of pause', () => {
  // A client that confuses the two has lost track of the run. Resuming here
  // would restart work whose actual pause nobody has addressed.
  assert.equal(releases('waiting_client', approval('approval-responded')), null);
  assert.equal(releases('waiting_approval', question('output-available')), null);
});

test('a running or finished run is released by nothing', () => {
  for (const status of ['queued', 'running', 'done', 'failed', 'cancelled'])
    assert.equal(releases(status, question('output-available')), null, status);
});

test('a user message never releases a run', () => {
  // Only the assistant turn carries the paused call; a new user message while a
  // run is paused is a new question, not an answer to the old one.
  assert.equal(
    releases('waiting_client', { role: 'user', parts: [{ type: 'text', text: 'nginx' }] }),
    null,
  );
});

test('a turn with one question still open is not an answer', () => {
  // Two questions in one step: sending on the first would resume the run with
  // the second still unanswered, and the model would answer it itself.
  assert.equal(
    hasAnsweredQuestion({
      role: 'assistant',
      parts: [
        { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-available' },
        { type: 'tool-ask_user', toolCallId: 'q2', state: 'input-available' },
      ],
    }),
    false,
  );
});

test('a completed server-side tool is not an answer', () => {
  // The narrow check matters: ask_user is the only tool with no execute on the
  // server, so it is the only one whose output may come from a browser.
  // Accepting any finished tool call would let a client supply a result the
  // server was supposed to produce.
  assert.equal(
    hasAnsweredQuestion({
      role: 'assistant',
      parts: [{ type: 'tool-bash', toolCallId: 'b1', state: 'output-available', output: 'ok' }],
    }),
    false,
  );
});

// --- What a reloading tab is told about a paused run --------------------

const { streamIsFinished, isPausedOnPerson } = await import('../lib/runs/resume.ts');

test('a run paused on a person has nothing left to stream', () => {
  // The defect this exists to prevent: a pause is not a terminal status, so a
  // reloaded tab opened a stream that could never yield and never closed. The
  // client stayed in "streaming", and its automatic send — the thing that
  // delivers the approval or the answer — only fires when the chat is idle. The
  // card rendered, the owner answered, and nothing happened.
  assert.equal(streamIsFinished('waiting_approval', false), true);
  assert.equal(streamIsFinished('waiting_client', false), true);
});

test('a run that is still working is still worth tailing', () => {
  assert.equal(streamIsFinished('queued', false), false);
  assert.equal(streamIsFinished('running', false), false);
});

test('a finished run is finished however it finished', () => {
  for (const status of ['done', 'failed', 'cancelled'])
    assert.equal(streamIsFinished(status, true), true, status);
});

test('working is not the same as waiting', () => {
  assert.equal(isPausedOnPerson('running'), false);
  assert.equal(isPausedOnPerson('waiting_approval'), true);
  assert.equal(isPausedOnPerson('waiting_client'), true);
});
