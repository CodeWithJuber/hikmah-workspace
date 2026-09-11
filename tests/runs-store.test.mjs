// The run store against a real SQLite file. These are the properties that make
// a run survive a closed tab and a restarted process.
// Run: node --test tests/runs-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRunStore } from '../lib/runs/store.ts';

const schema = readFileSync('drizzle/0004_runs.sql', 'utf8');

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-runs-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(schema);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = createRunStore(db);
  store.createConversation({ id: 'c1', userId: 'u1' });
  return { store, db, dir };
}

test('messages round-trip with their parts intact', async (t) => {
  const { store } = await freshStore(t);
  // Parts, not a flattened string: a reload has to rebuild tool calls and their
  // results, not just the prose.
  const parts = [
    { type: 'text', text: 'Checking that.' },
    {
      type: 'tool-calculate',
      state: 'output-available',
      input: { expression: '2+2' },
      output: { result: 4 },
    },
  ];
  store.appendMessage('c1', { id: 'm1', role: 'assistant', parts });
  const [restored] = store.listMessages('c1');
  assert.deepEqual(restored.parts, parts);
});

test('messages come back in the order they were written', async (t) => {
  const { store } = await freshStore(t);
  for (const id of ['a', 'b', 'c'])
    store.appendMessage('c1', { id, role: 'user', parts: [{ type: 'text', text: id }] });
  assert.deepEqual(
    store.listMessages('c1').map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('a run is claimed exactly once', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  const first = store.claimNext();
  assert.equal(first.id, 'r1');
  assert.equal(first.status, 'running');
  // The second caller must not get the same work. Without RETURNING on the
  // UPDATE this is a read-then-write race.
  assert.equal(store.claimNext(), null);
});

test('runs are claimed oldest first', async (t) => {
  const { store, db } = await freshStore(t);
  for (const id of ['r1', 'r2', 'r3'])
    store.createRun({ id, conversationId: 'c1', userId: 'u1', config: {} });
  // Same-millisecond creation is normal; the id tiebreak keeps it deterministic.
  db.exec("UPDATE runs SET created_at = '2026-01-01T00:00:00Z'");
  assert.deepEqual(
    [store.claimNext().id, store.claimNext().id, store.claimNext().id],
    ['r1', 'r2', 'r3'],
  );
});

test('a crash mid-run leaves work that is picked up again, not stranded', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.claimNext();
  assert.equal(store.getRun('r1').status, 'running');

  // Simulate the process dying and starting again.
  store.requeueRunning();
  assert.equal(store.getRun('r1').status, 'queued');
  assert.equal(store.claimNext().id, 'r1');
});

test('a finished run clears the conversation pointer', async (t) => {
  const { store, db } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  const active = () => db.prepare('SELECT active_run_id FROM conversations WHERE id = ?').get('c1');
  assert.equal(active().active_run_id, 'r1');
  store.finish('r1', 'done');
  assert.equal(active().active_run_id, null, 'a reopened tab must not re-attach to a finished run');
  assert.equal(store.getRun('r1').status, 'done');
});

test('a failed run keeps its reason', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.finish('r1', 'failed', 'The provider rejected the request.');
  const run = store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /provider rejected/);
});

test('events replay from the last sequence a client saw', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  for (const text of ['one', 'two', 'three'])
    store.appendEvent('r1', { type: 'text-delta', delta: text });

  // A client that already has seq 0 must receive exactly the rest, in order,
  // with no gap and no repeat.
  const resumed = store.eventsAfter('r1', 0);
  assert.deepEqual(
    resumed.map((e) => e.payload.delta),
    ['two', 'three'],
  );
  assert.deepEqual(
    resumed.map((e) => e.seq),
    [1, 2],
  );
  // A fresh client gets everything.
  assert.equal(store.eventsAfter('r1', -1).length, 3);
});

test('event sequence numbers do not restart between runs', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.createRun({ id: 'r2', conversationId: 'c1', userId: 'u1', config: {} });
  assert.equal(store.appendEvent('r1', { a: 1 }), 0);
  assert.equal(store.appendEvent('r1', { a: 2 }), 1);
  // Sequences are per run, so a second run starts its own numbering.
  assert.equal(store.appendEvent('r2', { b: 1 }), 0);
});

test('pruning clears the resume buffer without touching the run', async (t) => {
  const { store } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.appendEvent('r1', { type: 'text-delta', delta: 'x' });
  store.pruneEvents('r1');
  assert.equal(store.eventsAfter('r1', -1).length, 0);
  assert.ok(store.getRun('r1'), 'the run itself must survive its buffer being pruned');
});

test('deleting a conversation takes its runs and events with it', async (t) => {
  const { store, db } = await freshStore(t);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.appendEvent('r1', { a: 1 });
  db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');
  assert.equal(store.getRun('r1'), null);
  assert.equal(store.eventsAfter('r1', -1).length, 0);
});

test('one unfinished run per conversation is visible to the caller', async (t) => {
  // Two tabs on the same thread must not both start answering it.
  const { store } = await freshStore(t);
  assert.equal(store.activeForConversation('c1'), null);
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  assert.equal(store.activeForConversation('c1'), 'r1');
  store.finish('r1', 'done');
  assert.equal(store.activeForConversation('c1'), null, 'a finished run must not block the next');
});

test('active runs are counted per owner so a looping client cannot flood the queue', async (t) => {
  const { store } = await freshStore(t);
  store.createConversation({ id: 'c2', userId: 'u1' });
  store.createConversation({ id: 'c3', userId: 'u2' });
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  store.createRun({ id: 'r2', conversationId: 'c2', userId: 'u1', config: {} });
  store.createRun({ id: 'r3', conversationId: 'c3', userId: 'u2', config: {} });

  assert.equal(store.countActive('u1'), 2);
  assert.equal(store.countActive('u2'), 1, "another owner's runs must not count");

  store.finish('r1', 'cancelled');
  assert.equal(store.countActive('u1'), 1, 'a cancelled run frees its slot');
});
