// Message feedback store: set, replace, clear, ownership, value validity,
// and the cascade that wipes ratings when the message goes.
// Run: node --test tests/chat-v2-feedback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { createFeedbackStore, FeedbackNotFound } from '../lib/chat/feedback-store.ts';

async function freshStores(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-feedback-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const runs = createRunStore(db);
  const feedback = createFeedbackStore(db);
  // Two owners, one message each: the isolation tests write a rating on the
  // other owner's message and expect a refusal, not a write.
  runs.createConversation({ id: 'c1', userId: 'u1' });
  runs.createConversation({ id: 'c2', userId: 'u2' });
  runs.appendMessage('c1', { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] });
  runs.appendMessage('c2', { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'ho' }] });
  return { runs, feedback, db };
}

test('a rating is stored and read back', async (t) => {
  const { feedback } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'up');
  assert.deepEqual(feedback.getFeedback('c1', 'u1'), { m1: 'up' });
});

test('rating again replaces the earlier value', async (t) => {
  const { feedback } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'up');
  feedback.setFeedback('m1', 'c1', 'u1', 'down');
  assert.deepEqual(feedback.getFeedback('c1', 'u1'), { m1: 'down' });
});

test('rating null clears the row', async (t) => {
  const { feedback } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'up');
  feedback.setFeedback('m1', 'c1', 'u1', null);
  assert.deepEqual(feedback.getFeedback('c1', 'u1'), {});
});

test('a message of another owner cannot be rated', async (t) => {
  const { feedback } = await freshStores(t);
  assert.throws(
    () => feedback.setFeedback('m2', 'c2', 'u1', 'up'),
    FeedbackNotFound,
    'u1 must not rate u2’s message',
  );
  // And the attempt must have written nothing.
  assert.deepEqual(feedback.getFeedback('c2', 'u2'), {});
});

test('a message id outside the stated conversation is refused', async (t) => {
  // m1 is u1's message but lives in c1; claiming it under c2 must fail.
  const { feedback } = await freshStores(t);
  assert.throws(() => feedback.setFeedback('m1', 'c2', 'u1', 'up'), FeedbackNotFound);
  assert.deepEqual(feedback.getFeedback('c1', 'u1'), {});
});

test('a rating reads back only for its own conversation', async (t) => {
  const { feedback } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'up');
  assert.deepEqual(feedback.getFeedback('c2', 'u1'), {}, 'u1’s other conversation shows nothing');
  assert.deepEqual(
    feedback.getFeedback('c1', 'u2'),
    {},
    'u2 must not see u1’s ratings even with the conversation id',
  );
});

test('an invalid value is rejected before the CHECK constraint', async (t) => {
  const { feedback } = await freshStores(t);
  assert.throws(() => feedback.setFeedback('m1', 'c1', 'u1', 'meh'), RangeError);
  assert.throws(() => feedback.setFeedback('m1', 'c1', 'u1', undefined), RangeError);
});

test('deleting the message takes the rating with it', async (t) => {
  const { runs, feedback, db } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'up');
  runs.deleteConversation('c1', 'u1');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM message_feedback').get().n,
    0,
    'ON DELETE CASCADE must leave no orphan rating',
  );
});

test('feedback does not survive a raw message delete either', async (t) => {
  const { feedback, db } = await freshStores(t);
  feedback.setFeedback('m1', 'c1', 'u1', 'down');
  db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
  assert.deepEqual(feedback.getFeedback('c1', 'u1'), {});
});
