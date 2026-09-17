// Reopening a conversation whose run already failed.
//
// The reason is written on the run row, and until now nothing read it back:
// useChat only tails a run it considers active, and a failed one is not, so a
// reload of a failed conversation showed the question and no answer and no
// explanation. The transcript endpoint has to hand the reason over.
// Run: node --test tests/runs-last-failure.test.mjs
import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { INTERNAL_FAILURE, describeFailure, operatorRun } from '../lib/runs/failure.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  const store = createRunStore(db);
  store.createConversation({ id: 'c1', userId: 'u1', model: 'a/b' });
  store.appendMessage('c1', { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });
  return { db, store };
}

const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'a/b',
  freeOnly: true,
  apiKey: 'fixture-provider-key-for-durable-tests',
  instructions: 'x',
};

test('a conversation whose last run failed reports why', () => {
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'failed', 'The model rejected that request.');
  assert.equal(store.lastFailure('c1'), 'The model rejected that request.');
  db.close();
});

test('a finished conversation reports nothing', () => {
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'done', null);
  assert.equal(store.lastFailure('c1'), null);
  db.close();
});

test('a later success clears an earlier failure', () => {
  // Otherwise trying again and succeeding would still show the old reason on
  // the next reload, which reads as the retry having failed too.
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'failed', 'A transient provider error.');
  store.createRun({ id: 'r2', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r2', 'done', null);
  assert.equal(store.lastFailure('c1'), null);
  db.close();
});

test('a run still in flight is not a failure', () => {
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  assert.equal(store.lastFailure('c1'), null, 'working is not failed');
  db.close();
});

test('a cancelled run is not reported as a failure', () => {
  // Stopping an answer is something the person did on purpose; telling them
  // about it afterwards as though something went wrong would be a lie.
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'cancelled', null);
  assert.equal(store.lastFailure('c1'), null);
  db.close();
});

test('a failure with no recorded reason still says something', () => {
  const { db, store } = setup();
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'failed', null);
  assert.equal(
    store.lastFailure('c1'),
    'The run failed.',
    'a blank reason is worse than a plain one',
  );
  db.close();
});

test('failures do not cross between conversations', () => {
  const { db, store } = setup();
  store.createConversation({ id: 'c2', userId: 'u1', model: 'a/b' });
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config });
  store.claimNext();
  store.finish('r1', 'failed', 'Only c1 failed.');
  assert.equal(store.lastFailure('c2'), null);
  db.close();
});

// The operator is the one person who could read the server log, so telling them
// to go and read it is a dead end: the failure card on the deployed site said
// "the details are in the server log" to someone with no way to open one from
// the interface. They get the sentence that was thrown; everyone else still
// gets the summary, because our table names and stack frames are not theirs.
test('the operator is shown the real fault, and nobody else is', () => {
  const fault = new TypeError("cannot read properties of undefined (reading 'parts')");
  assert.equal(describeFailure(fault), INTERNAL_FAILURE);
  assert.match(describeFailure(fault, { operator: true }), /cannot read properties/);

  const sqlite = Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.id');
  assert.equal(describeFailure(sqlite), INTERNAL_FAILURE);
  assert.match(describeFailure(sqlite, { operator: true }), /messages\.id/);
});

test('the operator’s view is still bounded and still one line', () => {
  const long = Error('first line\n' + 'x'.repeat(5000));
  const shown = describeFailure(long, { operator: true });
  assert.equal(shown, 'first line');
  assert.ok(describeFailure(Error('y'.repeat(5000)), { operator: true }).length <= 300);
});

test('a run row written before this existed is not treated as the operator’s', () => {
  assert.equal(operatorRun(''), false);
  assert.equal(operatorRun('not json'), false);
  assert.equal(operatorRun('{}'), false);
  assert.equal(operatorRun('{"operator":true}'), true);
  // Not a boolean true is not true: a stray string must not promote a stranger.
  assert.equal(operatorRun('{"operator":"true"}'), false);
});
