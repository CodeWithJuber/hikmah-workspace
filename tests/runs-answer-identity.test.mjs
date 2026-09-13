// Every answer needs an id of its own, and the SDK does not supply one.
//
// `createAgentUIStream` folded through `readUIMessageStream` returns a message
// whose `id` is the empty string — not undefined. So `message.id ?? fallback`
// keeps `''`, and every assistant answer in the deployment was written under
// that one id: the first inserted, a second in another conversation hit the
// primary key and destroyed the answer, and a second in the same conversation
// silently overwrote the first.
//
// These drive the real worker over a real database with the shape the SDK
// actually produces, rather than a driver that invents a tidy id.
// Run: node --test tests/runs-answer-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../lib/runs/worker.ts';

const config = JSON.stringify({
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'a/b:free',
  apiKey: 'k',
  instructions: 'test',
});

/** What the SDK hands back: parts, and a blank id. */
const answer = (text) => ({
  message: { id: '', role: 'assistant', parts: [{ type: 'text', text }] },
});

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

/** One conversation with one question, and a run queued over it. */
function ask(store, conversationId, runId, text = 'hello') {
  if (!store.getConversation(conversationId))
    store.createConversation({ id: conversationId, userId: 'user-1', model: 'a/b:free' });
  store.appendMessage(conversationId, {
    id: conversationId + '-' + runId + '-user',
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  store.createRun({ id: runId, conversationId, userId: 'user-1', config });
}

const assistants = (store, conversationId) =>
  store.listMessages(conversationId).filter((message) => message.role === 'assistant');

test('a second conversation can store an answer', async (t) => {
  const worker = setup(t, async () => answer('the answer'));
  const { store } = worker;

  ask(store, 'conv-1', 'run-1');
  await worker.tick();
  ask(store, 'conv-2', 'run-2');
  await worker.tick();

  // Before the fix the second insert hit `messages.id`, the run was recorded
  // failed with the raw SQLite text, and the answer was gone.
  assert.equal(store.getRun('run-2')?.status, 'done');
  assert.equal(assistants(store, 'conv-2').length, 1);
  assert.equal(assistants(store, 'conv-2')[0].parts[0].text, 'the answer');
});

test('a second answer does not overwrite the first', async (t) => {
  let text = 'first';
  const worker = setup(t, async () => answer(text));
  const { store } = worker;

  ask(store, 'conv-1', 'run-1', 'one');
  await worker.tick();
  text = 'second';
  ask(store, 'conv-1', 'run-2', 'two');
  await worker.tick();

  const stored = assistants(store, 'conv-1');
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((message) => message.parts[0].text),
    ['first', 'second'],
  );
});

test('resuming one run updates its answer rather than adding another', async (t) => {
  let text = 'paused';
  let pause = true;
  const worker = setup(t, async () => ({ ...answer(text), awaitingApproval: pause }));
  const { store } = worker;

  ask(store, 'conv-1', 'run-1');
  await worker.tick();
  assert.equal(store.getRun('run-1')?.status, 'waiting_approval');

  // The same run, driven a second time after the person answered.
  text = 'continued';
  pause = false;
  store.requeueApproved('run-1');
  await worker.tick();

  const stored = assistants(store, 'conv-1');
  assert.equal(stored.length, 1, 'the resumed run continues its own turn');
  assert.equal(stored[0].parts[0].text, 'continued');
});

test('an answer that arrives with an id of its own keeps it', async (t) => {
  const worker = setup(t, async () => ({
    message: { id: 'm-from-sdk', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
  }));
  const { store } = worker;

  ask(store, 'conv-1', 'run-1');
  await worker.tick();

  assert.equal(assistants(store, 'conv-1')[0].id, 'm-from-sdk');
});

// A run that ends without saying anything.
//
// The loop can finish having called a tool and written no text: the model reads
// the result and returns an empty turn. Nothing caught that, so the run was
// recorded `done` and the transcript showed the working and then nothing — no
// answer, no error, nothing to press. Reported as "no response after mcp call".
test('a run that ends with tool calls and no words says so', async (t) => {
  const worker = setup(t, async () => ({
    message: {
      id: '',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__quran__fetch_grounding_rules',
          state: 'output-available',
          output: { ok: true },
        },
      ],
    },
    // What driveWithAgent computes from those parts.
    silent: true,
  }));
  const { store } = worker;

  ask(store, 'conv-1', 'run-1');
  await worker.tick();

  const run = store.getRun('run-1');
  assert.equal(run?.status, 'failed', 'not a success with nothing to show');
  assert.match(run?.error ?? '', /without writing an answer/i);
  // The working is still kept: what it did is worth reading even though it
  // never got to the answer.
  assert.equal(assistants(store, 'conv-1').length, 1);
});

test('an answer with words is not mistaken for silence', async (t) => {
  const worker = setup(t, async () => ({ ...answer('Here it is.'), silent: false }));
  const { store } = worker;
  ask(store, 'conv-1', 'run-1');
  await worker.tick();
  assert.equal(store.getRun('run-1')?.status, 'done');
});

// And the person watching has to be told, not just the row.
//
// The worker records the reason after the stream has closed, so a tab that
// watched the whole run live saw a clean ending and showed nothing at all —
// the reason appeared only on a reload, which is not where anyone is looking.
// Reported as "thinking is in a loop, no response".
test('a silent run streams its reason to whoever is watching', async (t) => {
  const seen = [];
  const worker = setup(t, async ({ emit }) => {
    emit({ type: 'text-start', id: '0' });
    // What the driver does when it finds no answer in the folded message.
    emit({ type: 'error', errorText: 'The model stopped without writing an answer.' });
    return { message: { id: '', role: 'assistant', parts: [] }, silent: true };
  });
  const { store } = worker;
  worker.bus.subscribe('run-1', (event) => seen.push(event.payload));

  ask(store, 'conv-1', 'run-1');
  await worker.tick();

  const errors = seen.filter((chunk) => chunk?.type === 'error');
  assert.equal(errors.length, 1, 'the tailing client is told, in the stream');
  assert.match(errors[0].errorText, /without writing an answer/i);
  // And the row still carries it for a reload.
  assert.equal(store.getRun('run-1')?.status, 'failed');
});
