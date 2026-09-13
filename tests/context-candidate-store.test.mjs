// The queue of sentences the owner's chats found hard.
//
// Written on the request path behind every message, so it has to be total: a
// queue that cannot be written is a feature that did not happen, never a
// conversation that did not send. And bounded, because it grows by a few rows
// per message and nothing removes them but review.
// Run: node --test tests/context-candidate-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MAX_QUEUED, createCandidateStore } from '../lib/context-model/candidate-store.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0012_context_candidates.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return createCandidateStore(db);
}

const candidate = (text, over = {}) => ({
  language: 'en',
  text,
  fingerprint: text.toLowerCase(),
  coverage: 0.5,
  score: 0,
  tokens: 5,
  annotation: { id: text.toLowerCase(), groupId: 'owner/chat', split: 'train', text, tokens: [] },
  ...over,
});

test('what a turn found hard is queued, hardest first', (t) => {
  const store = setup(t);
  store.record('u1', [
    // Everything known: the model was sure.
    candidate('A familiar sentence', { coverage: 1, score: 8 }),
    // Mostly unknown words: the case an owner's annotations actually fix.
    candidate('Ek naya jumla', { coverage: 0.1, score: -2 }),
  ]);
  const queue = store.queue('u1', 'en');
  assert.deepEqual(
    queue.map((row) => row.text),
    ['Ek naya jumla', 'A familiar sentence'],
  );
  // The parse comes back as an object, ready to be corrected.
  assert.equal(queue[0].annotation.groupId, 'owner/chat');
});

test('the same sentence twice is one row, with the newer parse', (t) => {
  const store = setup(t);
  store.record('u1', [candidate('Repeated sentence', { tokens: 5 })]);
  store.record('u1', [candidate('Repeated sentence', { tokens: 9 })]);
  const queue = store.queue('u1', 'en');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].tokens, 9, 'reparsed by whatever checkpoint is active now');
});

test('one owner cannot see another owner queue', (t) => {
  const store = setup(t);
  store.record('u1', [candidate('Mine')]);
  store.record('u2', [candidate('Theirs')]);
  assert.deepEqual(
    store.queue('u1', 'en').map((r) => r.text),
    ['Mine'],
  );
  assert.deepEqual(store.waiting('u2'), { en: 1 });
});

test('a reviewed sentence is not offered again', (t) => {
  const store = setup(t);
  store.record('u1', [candidate('Done with this'), candidate('Still waiting')]);
  assert.equal(store.reviewed('u1', 'en', ['done with this']), 1);
  assert.deepEqual(
    store.queue('u1', 'en').map((r) => r.text),
    ['Still waiting'],
  );
  assert.deepEqual(store.waiting('u1'), { en: 1 });
  // And recording it again does not resurrect it: dealt with stays dealt with,
  // or the same sentence returns every time it is mentioned.
  store.record('u1', [candidate('Done with this')]);
  assert.equal(store.queue('u1', 'en').length, 1);
});

test('the queue is bounded, and it is the easiest that go', (t) => {
  const store = setup(t);
  // One more than fits, the last being the hardest of all.
  const many = Array.from({ length: MAX_QUEUED + 1 }, (_, i) =>
    candidate('sentence number ' + i, { coverage: i === MAX_QUEUED ? 0 : 0.9 }),
  );
  store.record('u1', many);
  assert.equal(store.waiting('u1').en, MAX_QUEUED);
  assert.equal(
    store.queue('u1', 'en', 1)[0].text,
    'sentence number ' + MAX_QUEUED,
    'the hardest survives the trim',
  );
});

test('a queue that cannot be written costs the queue, not the message', (t) => {
  // No table at all: every method still answers rather than throwing, because
  // this runs beside a person's message.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createCandidateStore(db);
  assert.equal(store.record('u1', [candidate('Anything')]), 0);
  assert.deepEqual(store.queue('u1', 'en'), []);
  assert.deepEqual(store.waiting('u1'), {});
});
