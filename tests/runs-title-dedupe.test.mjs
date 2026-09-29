// Auto-titles come from the opening message, so two conversations that start
// the same way used to share one identical sidebar row. uniqueTitle gives the
// later ones " (2)", " (3)", … instead.
// Run: node --test tests/runs-title-dedupe.test.mjs
import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';

function store(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  t.after(() => db.close());
  return createRunStore(db);
}

function conversation(s, id, userId = 'user-1') {
  s.createConversation({ id, userId, model: 'a/b:free' });
}

test('the first conversation keeps the bare title', (t) => {
  const s = store(t);
  conversation(s, 'c1');
  assert.equal(s.uniqueTitle('user-1', 'Restart nginx', 'c1'), 'Restart nginx');
});

test('a second conversation with the same opening gets (2), then (3)', (t) => {
  const s = store(t);
  conversation(s, 'c1');
  conversation(s, 'c2');
  conversation(s, 'c3');
  s.setTitle('c1', s.uniqueTitle('user-1', 'Restart nginx', 'c1'));
  s.setTitle('c2', s.uniqueTitle('user-1', 'Restart nginx', 'c2'));
  s.setTitle('c3', s.uniqueTitle('user-1', 'Restart nginx', 'c3'));
  const titles = s
    .listConversations('user-1', 100)
    .map((row) => row.title)
    .sort();
  assert.deepEqual(titles, ['Restart nginx', 'Restart nginx (2)', 'Restart nginx (3)']);
});

test('titles do not collide across owners', (t) => {
  const s = store(t);
  conversation(s, 'c1', 'user-1');
  conversation(s, 'c2', 'user-2');
  s.setTitle('c1', s.uniqueTitle('user-1', 'Restart nginx', 'c1'));
  assert.equal(s.uniqueTitle('user-2', 'Restart nginx', 'c2'), 'Restart nginx');
});

test('a gap in the numbering is reused', (t) => {
  const s = store(t);
  conversation(s, 'c1');
  conversation(s, 'c2');
  s.setTitle('c1', 'Restart nginx');
  s.setTitle('c2', 'Restart nginx (3)');
  assert.equal(s.uniqueTitle('user-1', 'Restart nginx', 'c9'), 'Restart nginx (2)');
});
