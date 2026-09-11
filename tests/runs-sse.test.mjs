// SSE replay. The property under test is that a client which drops mid-answer
// reconnects and sees exactly what it missed: no gap, no repeat.
// Run: node --test tests/runs-sse.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { RunBus } from '../lib/runs/worker.ts';
import { resumeCursor, runEventStream } from '../lib/runs/sse.ts';

const schema = readFileSync('drizzle/0004_runs.sql', 'utf8');

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-sse-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(schema);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = createRunStore(db);
  store.createConversation({ id: 'c1', userId: 'u1' });
  store.createRun({ id: 'r1', conversationId: 'c1', userId: 'u1', config: {} });
  return { store, bus: new RunBus() };
}

/** Read the stream until it closes, returning the decoded text. */
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

const idsIn = (text) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

test('a finished run replays its buffer and then closes', async (t) => {
  const { store, bus } = await harness(t);
  for (const delta of ['a', 'b', 'c']) store.appendEvent('r1', { delta });
  store.finish('r1', 'done');

  const text = await drain(runEventStream({ runId: 'r1', after: -1, store, bus }));
  assert.deepEqual(idsIn(text), [0, 1, 2]);
  assert.match(text, /"delta":"a"/);
});

test('reconnecting from a cursor sends only what was missed', async (t) => {
  const { store, bus } = await harness(t);
  for (const delta of ['a', 'b', 'c', 'd']) store.appendEvent('r1', { delta });
  store.finish('r1', 'done');

  const text = await drain(runEventStream({ runId: 'r1', after: 1, store, bus }));
  assert.deepEqual(idsIn(text), [2, 3], 'no gap and no repeat after the cursor');
  assert.ok(!text.includes('"delta":"a"'));
});

test('a chunk written while the replay is being read is not lost', async (t) => {
  // The race this guards: subscribe, then read stored events, then drop
  // anything the replay already covered. Reading first would lose a chunk
  // written between the read and the subscribe.
  const { store, bus } = await harness(t);
  store.appendEvent('r1', { delta: 'stored' });

  const stream = runEventStream({ runId: 'r1', after: -1, store, bus });
  const seq = store.appendEvent('r1', { delta: 'live' });
  bus.emit('r1', { seq, payload: { delta: 'live' } });
  store.finish('r1', 'done');
  bus.end('r1');

  const text = await drain(stream);
  assert.match(text, /"delta":"stored"/);
  assert.match(text, /"delta":"live"/);
});

test('a live event already covered by the replay is not sent twice', async (t) => {
  const { store, bus } = await harness(t);
  const seq = store.appendEvent('r1', { delta: 'once' });
  store.finish('r1', 'done');

  const stream = runEventStream({ runId: 'r1', after: -1, store, bus });
  bus.emit('r1', { seq, payload: { delta: 'once' } });
  bus.end('r1');
  const text = await drain(stream);
  assert.equal(idsIn(text).length, 1, 'a duplicate would show the same tokens twice');
});

test('a keep-alive comment is sent so a quiet run is not dropped by a proxy', async (t) => {
  const { store, bus } = await harness(t);
  const stream = runEventStream({ runId: 'r1', after: -1, store, bus, keepaliveMs: 5 });
  const reader = stream.getReader();
  // The keep-alive timer is unref'd so it never holds the process open in
  // production; this ref'd timer keeps the loop alive for the assertion.
  const hold = setTimeout(() => {}, 1000);
  const { value } = await reader.read();
  clearTimeout(hold);
  // The run is still queued, so the only thing that can arrive is a keep-alive.
  assert.match(new TextDecoder().decode(value), /: keep-alive/);
  await reader.cancel();
});

test('aborting the request closes the stream', async (t) => {
  const { store, bus } = await harness(t);
  const controller = new AbortController();
  const stream = runEventStream({
    runId: 'r1',
    after: -1,
    store,
    bus,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await drain(stream), '');
});

test('the resume cursor is read from Last-Event-ID or the query, and bad input is ignored', () => {
  const at = (init) =>
    new Request('https://x.test/api/runs/r1/stream' + (init.query ?? ''), {
      headers: init.header ? { 'last-event-id': init.header } : {},
    });
  assert.equal(resumeCursor(at({ header: '7' })), 7);
  assert.equal(resumeCursor(at({ query: '?after=3' })), 3);
  // The header wins: it is what the browser resends automatically.
  assert.equal(resumeCursor(at({ header: '9', query: '?after=1' })), 9);
  // Anything unusable means "send everything" rather than skipping output.
  for (const bad of ['?after=abc', '?after=-5', '?after=']) {
    assert.equal(resumeCursor(at({ query: bad })), -1, bad);
  }
  assert.equal(resumeCursor(at({})), -1);
});
