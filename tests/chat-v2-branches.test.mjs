// Message branching: tree operations over messages, active-path materialization.
// Run: node --test tests/chat-v2-branches.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { createBranchStore } from '../lib/runs/branches.ts';

/** A clock that advances a second per read, so ordering by time is testable
 * without two writes landing in the same millisecond. */
function ticking(start = Date.UTC(2026, 0, 1)) {
  let at = start;
  return () => new Date((at += 1000)).toISOString();
}

async function fresh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-branches-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const clock = ticking();
  const store = createRunStore(db, clock);
  const branches = createBranchStore(db, clock);
  store.createConversation({ id: 'c1', userId: 'u1', title: 'chat' });
  store.createConversation({ id: 'c2', userId: 'u2', title: 'other' });
  // A linear tree: m1 (user) -> m2 (assistant) -> m3 (user) -> m4 (assistant).
  // The run store writes parent_id NULL; the parent links are set here, the
  // way earlier linear history looks after the migration ran.
  const tree = [
    ['m1', 'user'],
    ['m2', 'assistant'],
    ['m3', 'user'],
    ['m4', 'assistant'],
  ];
  const link = db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?');
  let parent = null;
  for (const [id, role] of tree) {
    store.appendMessage('c1', { id, role, parts: [{ type: 'text', text: id }] });
    if (parent) link.run(parent, id);
    parent = id;
  }
  return { db, store, branches };
}

function onPath(db, id) {
  return db.prepare('SELECT on_active_path AS v FROM messages WHERE id = ?').get(id).v;
}

function parentOf(db, id) {
  return db.prepare('SELECT parent_id AS v FROM messages WHERE id = ?').get(id).v;
}

test('a fresh conversation has one active path and no siblings', async (t) => {
  const { branches } = await fresh(t);
  assert.deepEqual(branches.activePath('c1'), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(
    branches.children('c1', 'm1').map((c) => c.id),
    ['m2'],
  );
  assert.deepEqual(
    branches.children('c1', null).map((c) => c.id),
    ['m1'],
  );
  const sib = branches.siblingsOf('c1', 'm3');
  assert.deepEqual(
    sib.siblings.map((s) => s.id),
    ['m3'],
  );
  assert.equal(sib.index, 0);
});

test('editing a user message branches: new sibling on path, old subtree off it', async (t) => {
  const { db, branches } = await fresh(t);
  const outcome = branches.editMessage('c1', 'u1', 'm3', [{ type: 'text', text: 'edited' }]);
  assert.ok('newId' in outcome, 'expected {newId}');
  const edited = outcome.newId;

  // The new message sits on the active path, in its parent's place.
  assert.deepEqual(branches.activePath('c1'), ['m1', 'm2', edited]);
  assert.equal(parentOf(db, edited), 'm2');
  const row = db
    .prepare('SELECT role AS role, parts AS parts FROM messages WHERE id = ?')
    .get(edited);
  assert.equal(row.role, 'user');
  assert.deepEqual(JSON.parse(row.parts), [{ type: 'text', text: 'edited' }]);

  // The old message and its whole active-path subtree went off the path.
  assert.equal(onPath(db, 'm3'), 0);
  assert.equal(onPath(db, 'm4'), 0);
  assert.equal(onPath(db, 'm1'), 1);
  assert.equal(onPath(db, 'm2'), 1);

  // Both versions are siblings now, the old one first.
  const oldSib = branches.siblingsOf('c1', 'm3');
  assert.deepEqual(
    oldSib.siblings.map((s) => s.id),
    ['m3', edited],
  );
  assert.equal(oldSib.index, 0);
  const newSib = branches.siblingsOf('c1', edited);
  assert.equal(newSib.siblings.length, 2);
  assert.equal(newSib.index, 1);

  // Editing twice keeps branching: the second edit's sibling group has three.
  const again = branches.editMessage('c1', 'u1', 'm3', [{ type: 'text', text: 'again' }]);
  assert.ok('newId' in again);
  const sibs = branches.siblingsOf('c1', again.newId);
  assert.equal(sibs.siblings.length, 3);
  assert.equal(sibs.index, 2);
});

test('editing a non-user message is refused', async (t) => {
  const { branches } = await fresh(t);
  assert.deepEqual(branches.editMessage('c1', 'u1', 'm2', []), { notUserMessage: true });
});

test('setActiveBranch flips the path in one go', async (t) => {
  const { db, branches } = await fresh(t);
  const outcome = branches.editMessage('c1', 'u1', 'm3', [{ type: 'text', text: 'edited' }]);
  assert.ok('newId' in outcome);
  const edited = outcome.newId;

  // Switching back to the old message reactivates its subtree. m4 has no
  // on-path child (it went off the path with the edit), so the walk follows
  // the latest child instead — which is exactly m4.
  const switched = branches.setActiveBranch('c1', 'u1', 'm3');
  assert.deepEqual(switched, { path: ['m1', 'm2', 'm3', 'm4'] });
  assert.deepEqual(branches.activePath('c1'), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(onPath(db, edited), 0);

  // Switching to a message already on the path is a no-op, not an error.
  const same = branches.setActiveBranch('c1', 'u1', 'm4');
  assert.deepEqual(same, { path: ['m1', 'm2', 'm3', 'm4'] });

  // Unknown message and foreign conversation ids give null.
  assert.equal(branches.setActiveBranch('c1', 'u1', 'nope'), null);
  assert.equal(branches.setActiveBranch('nope', 'u1', 'm1'), null);
  assert.equal(branches.siblingsOf('c1', 'nope'), null);
});

test('fork copies the active path prefix with new ids', async (t) => {
  const { db, branches } = await fresh(t);
  const forked = branches.forkConversation('c1', 'u1', 'm3', 'fork1');
  assert.deepEqual(forked, { id: 'fork1' });

  const conv = db
    .prepare('SELECT user_id AS u, title AS t, mode AS m FROM conversations WHERE id = ?')
    .get('fork1');
  assert.equal(conv.u, 'u1');
  assert.equal(conv.t, 'chat (fork)');
  assert.equal(conv.m, 'chat');

  const rows = db
    .prepare(
      'SELECT id, seq, role, parts, parent_id, on_active_path AS p FROM messages WHERE conversation_id = ? ORDER BY seq',
    )
    .all('fork1');
  // The prefix up to and including m3 — not the message after it.
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    rows.map((r) => r.role),
    ['user', 'assistant', 'user'],
  );
  assert.ok(rows.every((r) => r.p === 1));
  // New ids, none of the originals.
  for (const r of rows) assert.ok(!['m1', 'm2', 'm3', 'm4'].includes(r.id));
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  // The parent chain is preserved relatively.
  assert.equal(rows[0].parent_id, null);
  assert.equal(rows[1].parent_id, rows[0].id);
  assert.equal(rows[2].parent_id, rows[1].id);
  // Content survives the copy.
  assert.deepEqual(JSON.parse(rows[0].parts), [{ type: 'text', text: 'm1' }]);
});

test('cross-user branching is forbidden', async (t) => {
  const { branches } = await fresh(t);
  assert.deepEqual(branches.editMessage('c1', 'u2', 'm3', []), { forbidden: true });
  assert.deepEqual(branches.editMessage('c1', 'u1', 'nope', []), { forbidden: true });
  assert.equal(branches.setActiveBranch('c1', 'u2', 'm3'), null);
  assert.equal(branches.forkConversation('c1', 'u2', 'm3', 'fork2'), null);
  // And nothing leaked: no forked conversation exists.
  assert.equal(branches.activePath('c1').length, 4);
});

test('forking an edited branch copies that branch, not the original', async (t) => {
  const { db, branches } = await fresh(t);
  const outcome = branches.editMessage('c1', 'u1', 'm3', [{ type: 'text', text: 'edited' }]);
  assert.ok('newId' in outcome);
  const forked = branches.forkConversation('c1', 'u1', outcome.newId, 'fork3');
  assert.deepEqual(forked, { id: 'fork3' });
  const rows = db
    .prepare('SELECT parts AS parts FROM messages WHERE conversation_id = ? ORDER BY seq')
    .all('fork3');
  assert.equal(rows.length, 3);
  assert.deepEqual(JSON.parse(rows[2].parts), [{ type: 'text', text: 'edited' }]);
});
