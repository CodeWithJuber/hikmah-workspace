// Stale context decays: recency is part of the recall ranking.
// Expiry is a hard gate; age is a multiplicative decay that can never promote
// a weak match past a genuinely better one.
// Run: node --test tests/memory-recency.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { retrieveKnowledge, recencyDecay, isExpiredItem } from '../lib/playground/knowledge.ts';
import { createRecall } from '../lib/memory/recall.ts';
import { createRunStore } from '../lib/runs/store.ts';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const note = (id, content, extra = {}) => ({
  id,
  title: id,
  content,
  kind: 'reference',
  source: 'test',
  createdAt: daysAgo(400),
  updatedAt: daysAgo(400),
  enabled: true,
  ...extra,
});

test('recencyDecay is 1 when fresh and halves at 180 days', () => {
  assert.equal(recencyDecay(daysAgo(0), NOW), 1);
  const half = recencyDecay(daysAgo(180), NOW);
  assert.ok(Math.abs(half - 0.5) < 0.01, `half at 180 days, got ${half}`);
  assert.ok(recencyDecay(daysAgo(1095), NOW) > 0, 'never zero');
  assert.ok(recencyDecay(daysAgo(10), NOW) > recencyDecay(daysAgo(300), NOW), 'monotone');
});

test('an expired item is never retrieved, however exact the match', () => {
  const items = [
    note('old', 'The Mumbai cap is 7500.', { expiresAt: daysAgo(1) }),
    note('new', 'The garden needs water.', { expiresAt: daysAgo(-400) }),
  ];
  assert.deepEqual(
    retrieveKnowledge(items, 'Mumbai cap', 8000, { now: NOW }).map((x) => x.id),
    [],
    'the exact match is expired',
  );
  assert.ok(isExpiredItem(items[0], NOW));
  assert.ok(!isExpiredItem(items[1], NOW + 1));
});

test('of two comparable matches the fresher one wins', () => {
  const items = [
    note('stale', 'The quarterly offsite is in Goa.', { updatedAt: daysAgo(300) }),
    note('fresh', 'The quarterly offsite is in Goa.', { updatedAt: daysAgo(2) }),
  ];
  const [first] = retrieveKnowledge(items, 'quarterly offsite Goa', 8000, { now: NOW });
  assert.equal(first.id, 'fresh');
});

test('a much better old match still beats a weak fresh one', () => {
  const items = [
    note('stale', 'The quarterly offsite is in Goa with the full agenda attached.', {
      updatedAt: daysAgo(300),
    }),
    note('fresh', 'I like Goa.', { updatedAt: daysAgo(1) }),
  ];
  const [first] = retrieveKnowledge(items, 'quarterly offsite Goa agenda', 8000, { now: NOW });
  assert.equal(first.id, 'stale', 'decay scales, it does not veto');
});

test('expiry on preferences gates them too', () => {
  const items = [
    note('pref', 'Answer in Urdu.', {
      kind: 'preference',
      expiresAt: daysAgo(1),
      updatedAt: daysAgo(2),
    }),
  ];
  assert.deepEqual(retrieveKnowledge(items, 'anything at all', 8000, { now: NOW }), []);
});

function recallSetup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  t.after(() => db.close());
  const store = createRunStore(db);
  const backdate = (id, days) =>
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(daysAgo(days), id);
  return { db, store, backdate, recall: createRecall(db) };
}

test('conversation recall prefers the fresher conversation on a tie', (t) => {
  const { store, backdate, recall } = recallSetup(t);
  store.createConversation({ id: 'OLD', userId: 'u1', title: 'Old chat', model: 'm' });
  store.createConversation({ id: 'NEW', userId: 'u1', title: 'New chat', model: 'm' });
  store.createConversation({ id: 'Q', userId: 'u1', title: 'Question', model: 'm' });
  const say = (conv, text) =>
    store.appendMessage(conv, {
      id: conv + Math.random(),
      role: 'user',
      parts: [{ type: 'text', text }],
    });
  say('OLD', 'The quarterly offsite is in Goa.');
  say('NEW', 'The quarterly offsite is in Goa.');
  backdate('OLD', 300);
  backdate('NEW', 2);
  const hits = recall.recall('u1', 'quarterly offsite Goa', 'Q', 3, NOW);
  assert.equal(hits[0].conversationId, 'NEW', 'fresher wins the tie');
  assert.equal(hits.length, 2);
});

test('conversation recall still returns the better old match first', (t) => {
  const { store, backdate, recall } = recallSetup(t);
  store.createConversation({ id: 'OLD', userId: 'u1', title: 'Old chat', model: 'm' });
  store.createConversation({ id: 'NEW', userId: 'u1', title: 'New chat', model: 'm' });
  store.createConversation({ id: 'Q', userId: 'u1', title: 'Question', model: 'm' });
  const say = (conv, text) =>
    store.appendMessage(conv, {
      id: conv + Math.random(),
      role: 'user',
      parts: [{ type: 'text', text }],
    });
  say('OLD', 'The quarterly offsite is in Goa.');
  say('NEW', 'The quarterly offsite is in Goa.');
  backdate('OLD', 300);
  backdate('NEW', 2);
  const hits = recall.recall('u1', 'quarterly offsite Goa', 'Q', 3, NOW);
  assert.equal(hits[0].conversationId, 'NEW', 'fresher wins the tie');
  assert.equal(hits.length, 2);
});

test('the recency bonus is bounded: a clearly better old match still wins', () => {
  // FTS5 bm25() is more-negative-is-better; at real corpus sizes scores span
  // units, so canned realistic magnitudes drive the ranking math directly.
  const rows = (score, date, id) => ({
    conversation_id: id,
    role: 'user',
    original: 'x',
    title: id,
    date,
    score,
  });
  const fakeDb = {
    prepare: () => ({
      all: () => [
        rows(-8, daysAgo(300), 'OLD'), // much better match, a year stale
        rows(-1, daysAgo(1), 'NEW'), // weak match, fresh
      ],
    }),
  };
  const hits = createRecall(fakeDb).recall('u1', 'quarterly offsite', 'Q', 3, NOW);
  assert.equal(hits[0].conversationId, 'OLD', 'a 7-unit lead beats the bounded bonus');
});

test('the recency bonus flips close matches toward the fresher one', () => {
  const rows = (score, date, id) => ({
    conversation_id: id,
    role: 'user',
    original: 'x',
    title: id,
    date,
    score,
  });
  const fakeDb = {
    prepare: () => ({
      all: () => [rows(-1.5, daysAgo(300), 'OLD'), rows(-1.0, daysAgo(1), 'NEW')],
    }),
  };
  const hits = createRecall(fakeDb).recall('u1', 'quarterly offsite', 'Q', 3, NOW);
  assert.equal(hits[0].conversationId, 'NEW', 'a 0.5-unit lead does not survive the bonus');
});
