// Batched event writes, and the five places that must still see every chunk.
//
// `emit` ran two statements per streamed chunk on the one Node thread that also
// answers every panel's fetch: an UPDATE ... RETURNING to claim a sequence
// number and an INSERT. Measured on a WAL database with node:sqlite's defaults,
// 2,000 chunks cost 623 ms — 312 us each — so a long answer spent about a
// second of the event loop writing, and every request issued during it waited.
// In transactions of 50 the same 2,000 chunks cost 18 ms.
//
// What that trades is durability inside the flush window, and these are the
// tests that bound it. Each one fails if its flush is removed.
// Run: node --test tests/runs-event-batching.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-batch-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = createRunStore(db);
  store.createConversation({ id: 'c1', userId: 'u1' });
  const run = { id: store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} }) };
  return { store, db, run };
}

/** Rows actually on disk, read around the store so its flushes do not hide the
 * thing being measured. */
const onDisk = (db) => db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n;

test('a chunk gets its sequence number before it is written', async (t) => {
  const { store, db, run } = await freshStore(t);
  const seqs = [];
  for (let i = 0; i < 10; i += 1) seqs.push(store.appendEvent(run.id, { i }));
  // Contiguous from zero, handed back immediately — the bus sends this number
  // to a connected client, so it cannot wait for the transaction.
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // And genuinely still in memory. This is the whole optimisation: if this is
  // ever 10, the batching is gone and only the tests are passing.
  assert.equal(onDisk(db), 0, 'ten chunks were written one at a time');
});

test('fifty chunks flush themselves without anybody asking', async (t) => {
  const { store, db, run } = await freshStore(t);
  for (let i = 0; i < 50; i += 1) store.appendEvent(run.id, { i });
  // The buffer is bounded by rows as well as by time, so a fast provider on a
  // slow disk cannot grow it without limit.
  assert.equal(onDisk(db), 50);
});

test('a reconnecting client is never handed a gap', async (t) => {
  const { store, run } = await freshStore(t);
  for (let i = 0; i < 5; i += 1) store.appendEvent(run.id, { i });
  // eventsAfter is what a reconnect replays from. Without its flush this is
  // an empty array and the client silently loses five chunks.
  const replay = store.eventsAfter(run.id, -1);
  assert.deepEqual(
    replay.map((event) => event.seq),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    replay.map((event) => event.payload),
    [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }],
  );
});

test('the connect count sees buffered chunks too', async (t) => {
  const { store, run } = await freshStore(t);
  for (let i = 0; i < 3; i += 1) store.appendEvent(run.id, { i });
  // The stream route uses this to choose between a 204 and holding the
  // connection open. Zero here means a client with work waiting is told there
  // is none.
  assert.equal(store.countEventsAfter(run.id, -1), 3);
  assert.equal(store.countEventsAfter(run.id, 1), 1);
});

test('the run row knows how far the answer got', async (t) => {
  const { store, run } = await freshStore(t);
  for (let i = 0; i < 4; i += 1) store.appendEvent(run.id, { i });
  // lib/runs/sse.ts numbers a failure notice from this, and lib/runs/resume.ts
  // compares a client's cursor against it. Stale, the notice would reuse a
  // sequence number the client has already seen and the transport would loop.
  assert.equal(store.getRun(run.id).event_seq, 4);
});

test('a finished run has all of its answer on disk', async (t) => {
  const { store, db, run } = await freshStore(t);
  for (let i = 0; i < 6; i += 1) store.appendEvent(run.id, { i });
  store.finish(run.id, 'done');
  assert.equal(onDisk(db), 6, 'the last chunks were lost when the run ended');
});

test('pruning a step does not leave a buffered chunk behind to resurrect it', async (t) => {
  const { store, db, run } = await freshStore(t);
  for (let i = 0; i < 6; i += 1) store.appendEvent(run.id, { i });
  store.pruneEvents(run.id);
  assert.equal(onDisk(db), 0);
  // And they stay gone. Without the flush BEFORE the delete, the six chunks
  // are still in the buffer when the delete runs, and the next reader writes
  // them — resurrecting the step this just cleared, on disk, after it was
  // pruned.
  assert.deepEqual(store.eventsAfter(run.id, -1), []);
  assert.equal(onDisk(db), 0);
  // And the next step keeps counting from where the last one stopped, because
  // the cursor lives on the run row rather than being derived from a table
  // that was just emptied.
  assert.equal(store.appendEvent(run.id, { i: 6 }), 6);
});

test('a restart flushes rather than dropping the tail of an answer', async (t) => {
  const { store, db, run } = await freshStore(t);
  for (let i = 0; i < 3; i += 1) store.appendEvent(run.id, { i });
  // requeueRunning is what runs on SIGTERM and on boot.
  store.requeueRunning();
  assert.equal(onDisk(db), 3);
});

test('two runs interleaved keep their own sequences', async (t) => {
  const { store, run } = await freshStore(t);
  const other = {
    id: store.createRun({ id: 'r2', conversationId: 'c1', userId: 'u1', config: {} }),
  };
  const seqs = { [run.id]: [], [other.id]: [] };
  for (let i = 0; i < 6; i += 1) {
    const id = i % 2 ? other.id : run.id;
    seqs[id].push(store.appendEvent(id, { i }));
  }
  // One buffer, two cursors. A shared counter would have given run B the
  // numbers 1, 3 and 5 and left gaps a reconnect would wait forever to fill.
  assert.deepEqual(seqs[run.id], [0, 1, 2]);
  assert.deepEqual(seqs[other.id], [0, 1, 2]);
  assert.equal(store.getRun(run.id).event_seq, 3);
  assert.equal(store.getRun(other.id).event_seq, 3);
});

test('a conversation deleted mid-answer does not take the next run down with it', async (t) => {
  const { store, db, run } = await freshStore(t);
  store.createConversation({ id: 'c2', userId: 'u1' });
  const survivor = store.createRun({ id: 'r9', conversationId: 'c2', userId: 'u1', config: {} });
  store.appendEvent(run.id, { doomed: true });
  store.appendEvent(survivor, { kept: true });
  // Someone deletes the conversation from the list while its answer streams.
  // ON DELETE CASCADE takes the run and its events; the chunk already buffered
  // for it now has no run to belong to.
  db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');
  // Unbatched this could not happen — the row was written before the delete and
  // went with the cascade. Buffered, it arrives after, and a foreign key
  // failure would roll back the whole flush and lose the OTHER run's chunk too.
  assert.deepEqual(
    store.eventsAfter(survivor, -1).map((event) => event.payload),
    [{ kept: true }],
  );
  assert.equal(onDisk(db), 1);
});
