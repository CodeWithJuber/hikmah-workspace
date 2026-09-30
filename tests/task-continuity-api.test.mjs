// Task continuity HTTP surface (PR-16b).
// - POST /api/conversations/tasks: a retried start replays the same task
//   instead of dispatching a duplicate (idempotency key).
// - POST+GET /api/conversations/tasks/[id]/continuity: ask-once prompts and
//   the no-silent-replacement outcome rule.
// The heavy pieces (agent drive, provider access, knowledge recall) are
// stubbed; the stores, the SQLite schema, and the continuity logic are real.
// Run: node --test tests/task-continuity-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createTaskContinuityStore } from '../lib/tasks/continuity-store.ts';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-task-continuity-api-'));
const db = applySchema(new DatabaseSync(':memory:'));
globalThis.__taskApiStorage = { raw: db };
globalThis.__taskApiUser = null;
globalThis.__taskApiEnqueueMode = 'ok';
globalThis.__taskApiEnqueueCalls = [];

const fixtures = {
  name: 'runtime-fixtures',
  setup(builder) {
    builder.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'auth', namespace: 'test' }));
    builder.onResolve({ filter: /^@\/server\/storage\.mjs$/ }, () => ({
      path: 'storage',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^@\/lib\/runs\/service$/ }, () => ({
      path: 'svc',
      namespace: 'test',
    }));
    // The svc stub needs the real run store; a second resolve hands it a
    // real on-disk file, which loads with the normal loader.
    builder.onResolve({ filter: /^test-real-run-store$/ }, () => ({
      path: join(process.cwd(), 'lib/runs/store.ts'),
    }));
    builder.onResolve({ filter: /^@\/lib\/ai\/chat-request$/ }, () => ({
      path: 'chatreq',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^ai$/ }, () => ({ path: 'ai', namespace: 'test' }));
    builder.onResolve({ filter: /^@\/lib\/runs\/enqueue$/ }, () => ({
      path: 'enqueue',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^@\/lib\/runs\/prepare$/ }, () => ({
      path: 'prepare',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^@\/lib\/chat\/settings-store$/ }, () => ({
      path: 'settings',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^@\/lib\/runs\/telemetry$/ }, () => ({
      path: 'telemetry',
      namespace: 'test',
    }));
    builder.onResolve({ filter: /^@\/lib\/workflow\/store$/ }, () => ({
      path: 'workflow',
      namespace: 'test',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => {
      const contents = {
        auth: 'export async function getChatGPTUser(){ return globalThis.__taskApiUser; }',
        storage: 'export function getStorage(){ return globalThis.__taskApiStorage; }',
        // The worker is the real run store on the test database; only the
        // agent drive is fake (the bus and the tick are no-ops).
        svc: `
          import { createRunStore } from 'test-real-run-store';
          let n = 0;
          export function newConversationId(){ return 'tconv-' + (++n); }
          export function newMessageId(){ return 'tmsg-' + (++n); }
          export function newRunId(){ return 'trun-' + (++n); }
          export function runService(){
            if (!globalThis.__taskApiWorker) {
              const store = createRunStore(globalThis.__taskApiStorage.raw);
              globalThis.__taskApiWorker = { store, bus: { emit(){} }, tick(){} };
            }
            return globalThis.__taskApiWorker;
          }`,
        chatreq: `
          export class ChatRequestError extends Error {
            constructor(message, status = 400){ super(message); this.status = status; }
          }
          export function assertSameOrigin(request, expected){
            const origin = request.headers.get('origin');
            if (!origin || origin !== expected)
              throw new ChatRequestError('Use chat from your signed-in workspace.', 403);
          }
          export async function parseChatRequest(){
            return { model: 'fixture-model', tier: 'pro', baseUrl: '', instructions: '',
              incognito: false, freeOnly: false, maxSteps: 8, contextCharacters: 1000,
              contextWindow: 8000, disabledTools: [], enabledTools: [] };
          }`,
        ai: 'export async function validateUIMessages(input){ return input.messages; }',
        // The queue is real enough to name the run row; the driver is not run.
        enqueue: `
          export class EnqueueFullError extends Error {}
          export function enqueueCap(){ return 2; }
          export function enqueueRun(job){
            globalThis.__taskApiEnqueueCalls.push(job);
            const mode = globalThis.__taskApiEnqueueMode;
            if (mode === 'fail') throw new Error('enqueue failed');
            if (mode === 'full') throw new EnqueueFullError('queue full');
            job.store.createRun({ id: job.runId, conversationId: job.conversationId,
              userId: job.userId, config: job.config, priority: job.priority });
            // Dispatched, not driven: finish immediately so the queue stays
            // empty and later tests are not throttled by the real cap check.
            job.store.finish(job.runId, 'done');
          }`,
        prepare: `
          export async function resolveRunAccess(){
            return { access: { ok: true, apiKey: '', metered: false, execution: 'local',
              entitlements: { tier: 'owner', media: false } }, refused: null };
          }
          export async function knowledgeFor(){
            return { block: '', recall: '', used: [], conversations: [] };
          }`,
        settings: `export function createChatSettingsStore(){
          return { read(){ return { memory: { recallConversations: false } }; } };
        }`,
        telemetry: 'export function phaseChunk(){ return {}; }',
        workflow: 'export function createWorkflowStore(){ return {}; }',
      }[path];
      return { loader: 'js', contents };
    });
  },
};

await build({
  entryPoints: ['app/api/conversations/tasks/route.ts'],
  outfile: join(directory, 'tasks-api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [fixtures],
});
await build({
  entryPoints: ['app/api/conversations/tasks/[id]/continuity/route.ts'],
  outfile: join(directory, 'continuity-api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [fixtures],
});
const tasksApi = await import(pathToFileURL(join(directory, 'tasks-api.mjs')));
const continuityApi = await import(pathToFileURL(join(directory, 'continuity-api.mjs')));

const TASKS_URL = 'https://hikmah.test/api/conversations/tasks';
const startTask = (body, origin = 'https://hikmah.test') =>
  tasksApi.POST(
    new Request(TASKS_URL, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const continuityUrl = (id) => `https://hikmah.test/api/conversations/tasks/${id}/continuity`;
const continuityGet = (id) =>
  continuityApi.GET(new Request(continuityUrl(id)), { params: Promise.resolve({ id }) });
const continuityPost = (id, body, origin = 'https://hikmah.test') =>
  continuityApi.POST(
    new Request(continuityUrl(id), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const enqueueCalls = () => globalThis.__taskApiEnqueueCalls.length;

test.after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
  delete globalThis.__taskApiStorage;
  delete globalThis.__taskApiUser;
  delete globalThis.__taskApiEnqueueMode;
  delete globalThis.__taskApiEnqueueCalls;
  delete globalThis.__taskApiWorker;
});

// ---------------------------------------------------------------------------
// Idempotent dispatch.
// ---------------------------------------------------------------------------

test('starting a task needs a session and a bounded key', async () => {
  assert.equal((await startTask({ brief: 'Learn X.' })).status, 401);
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  assert.equal((await startTask({ brief: 'Learn X.' }, 'https://attacker.test')).status, 403);
  assert.equal((await startTask({ brief: '' })).status, 400);
  const tooLong = await startTask({ brief: 'Learn X.', idempotencyKey: 'k'.repeat(129) });
  assert.equal(tooLong.status, 400);
  assert.equal(enqueueCalls(), 0);
});

test('a retried start replays the same task — one dispatch, not two', async () => {
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  const key = 'start-key-one';
  const first = await startTask({ brief: 'Learn the water cycle.', idempotencyKey: key });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.ok(firstBody.conversationId);
  assert.ok(firstBody.runId);
  assert.equal(firstBody.resumed, undefined);
  assert.equal(enqueueCalls(), 1);

  // The retry — a lost response, a double tap — finds the key, not a new run.
  const retry = await startTask({ brief: 'Learn the water cycle.', idempotencyKey: key });
  assert.equal(retry.status, 200);
  const retryBody = await retry.json();
  assert.equal(retryBody.conversationId, firstBody.conversationId);
  assert.equal(retryBody.runId, firstBody.runId);
  assert.equal(retryBody.resumed, true);
  assert.equal(enqueueCalls(), 1);

  // But a fresh start with a fresh key still dispatches a fresh task.
  const second = await startTask({
    brief: 'Learn the water cycle.',
    idempotencyKey: 'start-key-two',
  });
  assert.equal(second.status, 202);
  assert.notEqual((await second.json()).conversationId, firstBody.conversationId);
  assert.equal(enqueueCalls(), 2);

  // And a start with no key at all is untouched by all of this.
  const keyless = await startTask({ brief: 'Learn the tides.' });
  assert.equal(keyless.status, 202);
  assert.equal(enqueueCalls(), 3);
});

test('a failed dispatch leaves no continuity row behind for the key', async () => {
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  globalThis.__taskApiEnqueueMode = 'fail';
  const key = 'start-key-failing';
  const failed = await startTask({ brief: 'Learn failing.', idempotencyKey: key });
  assert.equal(failed.status, 503);
  const continuity = createTaskContinuityStore(db);
  assert.equal(continuity.findByKey('owner-one', key), null);

  // So the retry after the failure starts the task for real.
  globalThis.__taskApiEnqueueMode = 'ok';
  const before = enqueueCalls();
  const retried = await startTask({ brief: 'Learn failing.', idempotencyKey: key });
  assert.equal(retried.status, 202);
  assert.equal(enqueueCalls(), before + 1);
  assert.ok(continuity.findByKey('owner-one', key));
});

// ---------------------------------------------------------------------------
// Continuity state: prompts asked once, outcomes never silently replaced.
// ---------------------------------------------------------------------------

async function seededTask(t, { userId = 'owner-one', key = 'continuity-key' } = {}) {
  const runs = createRunStore(db);
  runs.createConversation({ id: `seed-${key}`, userId, mode: 'task', model: 'm' });
  createTaskContinuityStore(db).create({
    conversationId: `seed-${key}`,
    userId,
    idempotencyKey: key,
    runId: null,
  });
  t.after(() => {
    // The seed rows are per-key unique; each test seeds its own key.
  });
  return `seed-${key}`;
}

test('the continuity route is private to the task owner', async (t) => {
  const id = await seededTask(t);
  globalThis.__taskApiUser = null;
  assert.equal((await continuityGet(id)).status, 401);
  globalThis.__taskApiUser = { userId: 'someone-else', email: 'x@example.test' };
  assert.equal((await continuityGet(id)).status, 404);
  assert.equal((await continuityPost(id, { action: 'ensure-prompt' })).status, 404);
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  assert.equal((await continuityGet(id)).status, 200);
});

test('a pending run re-binds on reload; a finished run settles', async (t) => {
  const id = await seededTask(t, { key: 'rebind-key' });
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  let state = await (await continuityGet(id)).json();
  assert.deepEqual(state.decision, { action: 'none' });

  const runs = createRunStore(db);
  runs.createRun({ id: 'live-run-1', conversationId: id, userId: 'owner-one', config: {} });
  state = await (await continuityGet(id)).json();
  assert.deepEqual(state.decision, { action: 'rebind', runId: 'live-run-1', status: 'queued' });

  runs.finish('live-run-1', 'done');
  state = await (await continuityGet(id)).json();
  assert.deepEqual(state.decision, { action: 'settled', runId: 'live-run-1', status: 'done' });
});

test('a disambiguation prompt is asked once and answered once', async (t) => {
  const id = await seededTask(t, { key: 'prompt-key' });
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };

  const ask = {
    action: 'ensure-prompt',
    id: 'region',
    question: 'Which region?',
    options: ['EMEA', 'APAC'],
  };
  const first = await (await continuityPost(id, ask)).json();
  assert.equal(first.created, true);
  // A reload re-asking the same prompt gets the same one back, not a second.
  const again = await (await continuityPost(id, ask)).json();
  assert.equal(again.created, false);
  assert.equal(again.prompt.id, 'region');

  let state = await (await continuityGet(id)).json();
  assert.equal(state.prompts.length, 1);
  assert.equal(state.audit.filter((a) => a.action === 'prompt_asked').length, 1);

  const answer = await (
    await continuityPost(id, {
      action: 'resolve-prompt',
      id: 'region',
      resolution: 'EMEA',
    })
  ).json();
  assert.equal(answer.prompt.resolution, 'EMEA');
  // A double-submitted answer is absorbed, not double-counted.
  const reanswer = await (
    await continuityPost(id, {
      action: 'resolve-prompt',
      id: 'region',
      resolution: 'APAC',
    })
  ).json();
  assert.equal(reanswer.prompt.resolution, 'EMEA');

  state = await (await continuityGet(id)).json();
  assert.equal(state.prompts.length, 0);
  assert.equal(state.audit.filter((a) => a.action === 'prompt_resolved').length, 1);

  // Bad input is refused before anything is written.
  assert.equal(
    (await continuityPost(id, { action: 'ensure-prompt', id: '', question: 'x' })).status,
    400,
  );
  assert.equal(
    (await continuityPost(id, { action: 'resolve-prompt', id: 'unknown', resolution: 'x' })).status,
    404,
  );
  assert.equal((await continuityPost(id, { action: 'nope' })).status, 400);
});

test('an outcome is recorded once, then only replaced explicitly', async (t) => {
  const id = await seededTask(t, { key: 'outcome-key' });
  globalThis.__taskApiUser = { userId: 'owner-one', email: 'owner@example.test' };
  const outcome = { status: 'done', summary: 'Learned the water cycle.', runId: 'live-run-1' };

  const recorded = await (await continuityPost(id, { action: 'record-outcome', outcome })).json();
  assert.equal(recorded.outcome.summary, 'Learned the water cycle.');
  // A second record is a conflict, not a silent overwrite.
  assert.equal((await continuityPost(id, { action: 'record-outcome', outcome })).status, 409);
  // So is a replacement without the explicit flag.
  assert.equal(
    (
      await continuityPost(id, {
        action: 'replace-outcome',
        outcome: { ...outcome, summary: 'Other.' },
      })
    ).status,
    400,
  );

  const replaced = await (
    await continuityPost(id, {
      action: 'replace-outcome',
      outcome: { ...outcome, status: 'failed', summary: 'The report was wrong.' },
      explicit: true,
      reason: 'The source was retracted.',
    })
  ).json();
  assert.equal(replaced.outcome.summary, 'The report was wrong.');

  const state = await (await continuityGet(id)).json();
  assert.equal(state.outcome.status, 'failed');
  const actions = state.audit.map((a) => a.action);
  assert.ok(actions.includes('outcome_recorded'));
  assert.ok(actions.includes('outcome_replaced'));

  // Bad input is refused.
  assert.equal(
    (
      await continuityPost(id, {
        action: 'record-outcome',
        outcome: { status: 'bogus', summary: 'x' },
      })
    ).status,
    400,
  );
});
