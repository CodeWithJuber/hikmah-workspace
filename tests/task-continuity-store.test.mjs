// Task continuity persistence: one row per task conversation, against the
// real migrations (tests/schema.mjs applies the whole drizzle/ directory, so
// this also proves the new migration applies cleanly in order).
// Run: node --test tests/task-continuity-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createTaskContinuityStore } from '../lib/tasks/continuity-store.ts';

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-task-continuity-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

function ticking(start = Date.UTC(2026, 8, 30)) {
  let at = start;
  return () => new Date((at += 1000)).toISOString();
}

async function setup(t) {
  const db = await freshDb(t);
  const clock = ticking();
  const runs = createRunStore(db, clock);
  const continuity = createTaskContinuityStore(db, clock);
  runs.createConversation({ id: 'task-1', userId: 'user-1', mode: 'task', model: 'm' });
  return { db, runs, continuity };
}

test('create and get round-trip with sane defaults', async (t) => {
  const { continuity } = await setup(t);
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: 'key-1',
    runId: 'run-1',
  });
  const row = continuity.get('task-1');
  assert.equal(row?.conversationId, 'task-1');
  assert.equal(row?.userId, 'user-1');
  assert.equal(row?.idempotencyKey, 'key-1');
  assert.equal(row?.runId, 'run-1');
  assert.deepEqual(row?.prompts, []);
  assert.equal(row?.outcome, null);
  assert.deepEqual(row?.audit, []);
  assert.equal(continuity.get('missing'), null);
});

test('findByKey matches the exact key for the same owner only', async (t) => {
  const { continuity, runs } = await setup(t);
  runs.createConversation({ id: 'task-2', userId: 'user-2', mode: 'task', model: 'm' });
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: 'key-1',
    runId: 'run-1',
  });
  continuity.create({
    conversationId: 'task-2',
    userId: 'user-2',
    idempotencyKey: 'key-1',
    runId: 'run-2',
  });
  assert.equal(continuity.findByKey('user-1', 'key-1')?.conversationId, 'task-1');
  assert.equal(continuity.findByKey('user-2', 'key-1')?.conversationId, 'task-2');
  assert.equal(continuity.findByKey('user-1', 'key-2'), null);
  assert.equal(continuity.findByKey('user-3', 'key-1'), null);
});

test('the same key cannot start two rows for one owner — the dedupe arbiter', async (t) => {
  const { continuity } = await setup(t);
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: 'key-1',
    runId: 'run-1',
  });
  assert.throws(
    () =>
      continuity.create({
        conversationId: 'task-1',
        userId: 'user-1',
        idempotencyKey: 'key-1',
        runId: 'run-2',
      }),
    /UNIQUE constraint failed/,
  );
});

test('tasks without a key are unaffected by the unique index', async (t) => {
  const { continuity, runs } = await setup(t);
  runs.createConversation({ id: 'task-2', userId: 'user-1', mode: 'task', model: 'm' });
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: null,
    runId: 'run-1',
  });
  continuity.create({
    conversationId: 'task-2',
    userId: 'user-1',
    idempotencyKey: null,
    runId: 'run-2',
  });
  assert.equal(continuity.get('task-2')?.idempotencyKey, null);
});

test('a row cannot name a conversation that does not exist', async (t) => {
  const { continuity } = await setup(t);
  assert.throws(
    () =>
      continuity.create({
        conversationId: 'ghost',
        userId: 'user-1',
        idempotencyKey: 'key-9',
        runId: 'run-9',
      }),
    /FOREIGN KEY/,
  );
});

test('save persists prompts and outcome and appends audit entries', async (t) => {
  const { continuity } = await setup(t);
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: 'key-1',
    runId: 'run-1',
  });
  const prompts = [
    {
      id: 'p1',
      question: 'Which region?',
      options: [],
      createdAt: '2026-09-30T04:00:00.000Z',
      resolvedAt: null,
      resolution: null,
      resolvedBy: null,
    },
  ];
  continuity.save('task-1', { prompts, outcome: null }, [
    { at: '2026-09-30T04:00:00.000Z', actor: 'user-1', action: 'prompt_asked', detail: {} },
  ]);
  let row = continuity.get('task-1');
  assert.equal(row?.prompts.length, 1);
  assert.equal(row?.audit.length, 1);
  // A second save appends, never rewrites, the audit trail.
  const outcome = {
    status: 'done',
    summary: 'Learned X.',
    runId: 'run-1',
    recordedAt: '2026-09-30T05:00:00.000Z',
    recordedBy: 'user-1',
  };
  continuity.save('task-1', { prompts, outcome }, [
    { at: '2026-09-30T05:00:00.000Z', actor: 'user-1', action: 'outcome_recorded', detail: {} },
  ]);
  row = continuity.get('task-1');
  assert.equal(row?.outcome?.summary, 'Learned X.');
  assert.equal(row?.audit.length, 2);
  assert.equal(row?.audit[0]?.action, 'prompt_asked');
  assert.equal(row?.audit[1]?.action, 'outcome_recorded');
});

test('save on a missing row throws', async (t) => {
  const { continuity } = await setup(t);
  assert.throws(() => continuity.save('ghost', { prompts: [], outcome: null }, []), /no row/);
});

test('remove deletes the row', async (t) => {
  const { continuity } = await setup(t);
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: 'key-1',
    runId: 'run-1',
  });
  continuity.remove('task-1');
  assert.equal(continuity.get('task-1'), null);
});

test('corrupt JSON columns throw rather than being guessed at', async (t) => {
  const { db, continuity } = await setup(t);
  continuity.create({
    conversationId: 'task-1',
    userId: 'user-1',
    idempotencyKey: null,
    runId: null,
  });
  db.exec(`UPDATE task_continuity SET prompts = 'not json' WHERE conversation_id = 'task-1'`);
  assert.throws(() => continuity.get('task-1'), /not valid JSON/);
});

test('newestRun reads the task run live from the run store', async (t) => {
  const { runs, continuity } = await setup(t);
  assert.equal(continuity.newestRun('task-1'), null);
  runs.createRun({ id: 'run-1', conversationId: 'task-1', userId: 'user-1', config: {} });
  runs.createRun({ id: 'run-2', conversationId: 'task-1', userId: 'user-1', config: {} });
  const newest = continuity.newestRun('task-1');
  assert.equal(newest?.id, 'run-2');
  assert.equal(newest?.status, 'queued');
  runs.finish('run-2', 'done');
  assert.equal(continuity.newestRun('task-1')?.status, 'done');
});
