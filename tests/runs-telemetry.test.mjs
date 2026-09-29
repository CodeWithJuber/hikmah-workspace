// Run telemetry: timed segments, phase announcements, and machine-readable
// reason codes. The point of these tests is the behaviour a user (and the
// client progress UI) notices: the narration follows the run's real phases,
// every run leaves a timeline of how long each segment took, and a failed run
// says *why* in a code — while never leaking secrets into that timeline.
// Run: node --test tests/runs-telemetry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../lib/runs/worker.ts';
import { BudgetExhaustedError } from '../lib/ai/budget-middleware.ts';
import {
  RUN_SEGMENTS,
  RUN_REASON_CODES,
  isRunReasonCode,
  isRunPhase,
  phaseChunk,
  phaseFromParts,
  usefulChunk,
  reasonCodeFor,
} from '../lib/runs/telemetry.ts';
import { approvalDenied } from '../lib/runs/resume.ts';

async function harness(t, drive, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-telemetry-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const worker = createWorker({ db, drive, onError: () => {}, ...options });
  worker.store.createConversation({ id: 'c1', userId: 'u1' });
  const queue = (id, config = {}, priority = 0) =>
    worker.store.createRun({ id, conversationId: 'c1', userId: 'u1', config, priority });
  return { worker, db, queue };
}

/** Every run_events payload for a run, in stream order. */
function eventPayloads(worker, runId) {
  return worker.store.eventsAfter(runId, -1).map((e) => e.payload);
}

/** All telemetry segments for a run. */
function timeline(worker, runId) {
  return worker.store.runTimeline(runId);
}

// ---------------------------------------------------------------------------
// Pure unit behaviour: the segment list, the phases, the reason codes.

test('the segment list is fixed and in boundary order', () => {
  assert.deepEqual(RUN_SEGMENTS, [
    'queue_wait',
    'preparation',
    'mcp_handshake',
    'jev_decision',
    'first_byte',
    'useful_output',
  ]);
});

test('every reason code is known, and only known codes validate', () => {
  assert.deepEqual(RUN_REASON_CODES, [
    'completed',
    'cancelled',
    'awaiting-approval',
    'awaiting-answer',
    'no-answer',
    'budget-exhausted',
    'timeout',
    'provider-error',
    'internal-error',
    'denied',
  ]);
  assert.equal(isRunReasonCode('timeout'), true);
  assert.equal(isRunReasonCode('nope'), false);
  assert.equal(isRunPhase('streaming'), true);
  assert.equal(isRunPhase('napping'), false);
});

test('phaseFromParts reads the latest phase part and ignores everything else', () => {
  const parts = [
    { type: 'text', text: 'hello' },
    phaseChunk('r1', 'queued'),
    { type: 'data-memories', data: {} },
    phaseChunk('r1', 'streaming'),
  ];
  assert.equal(phaseFromParts(parts), 'streaming');
  assert.equal(phaseFromParts([]), null);
  assert.equal(phaseFromParts([{ type: 'text', text: 'x' }]), null);
  // Garbage data cannot smuggle a phase in.
  assert.equal(
    phaseFromParts([{ type: 'data-run-phase', data: { phase: 'napping', runId: 'r1' } }]),
    null,
  );
  assert.equal(phaseFromParts([{ type: 'data-run-phase' }]), null);
});

test('a phase chunk carries the phase, the run id, and nothing else', () => {
  const chunk = phaseChunk('r1', 'streaming');
  assert.equal(chunk.type, 'data-run-phase');
  assert.equal(chunk.id, 'run-phase');
  assert.deepEqual(chunk.data, { phase: 'streaming', runId: 'r1' });
  assert.equal('apiKey' in chunk.data, false);
  assert.equal('instructions' in chunk.data, false);
  // Terminal and transition phases may carry the reason code as well.
  assert.deepEqual(phaseChunk('r1', 'done', 'completed').data, {
    phase: 'done',
    runId: 'r1',
    reasonCode: 'completed',
  });
});

test('usefulChunk recognises an answer when it sees one', () => {
  // AI SDK v5 text-delta chunks carry their words on `delta`, not `text`.
  assert.equal(usefulChunk({ type: 'text-delta', delta: 'some words' }), true);
  assert.equal(usefulChunk({ type: 'text-delta', delta: '   ' }), false);
  assert.equal(usefulChunk({ type: 'text', text: 'words' }), true);
  assert.equal(usefulChunk({ type: 'file', mediaType: 'image/png' }), true);
  assert.equal(usefulChunk({ type: 'data-plan', data: {} }), true);
  // Bookkeeping parts are not an answer: a run that produced only these
  // has not said anything yet.
  assert.equal(usefulChunk({ type: 'start' }), false);
  assert.equal(usefulChunk({ type: 'finish' }), false);
  assert.equal(usefulChunk({ type: 'step-start' }), false);
  assert.equal(usefulChunk({ type: 'data-memories', data: {} }), false);
  assert.equal(usefulChunk({ type: 'data-run-phase', data: {} }), false);
  assert.equal(usefulChunk({ type: 'reasoning-delta', text: 'hmm' }), false);
});

test('reasonCodeFor names the failure by its shape', () => {
  const firstByte = new Error('busy');
  firstByte.name = 'FirstByteTimeout';
  assert.equal(reasonCodeFor(firstByte), 'timeout');
  assert.equal(reasonCodeFor(new BudgetExhaustedError('cap')), 'budget-exhausted');
  assert.equal(reasonCodeFor(new Error('the provider rate limited us')), 'provider-error');
  assert.equal(reasonCodeFor(new Error('provider 503 exploded')), 'provider-error');
  assert.equal(reasonCodeFor(new TypeError('cannot read property')), 'internal-error');
  assert.equal(reasonCodeFor('a string, not an error'), 'internal-error');
  assert.equal(reasonCodeFor(null), 'internal-error');
});

test('approvalDenied only fires on an actual denial', () => {
  const message = (approved) => ({
    role: 'assistant',
    parts: [{ type: 'tool-x', state: 'approval-responded', approval: { approved } }],
  });
  assert.equal(approvalDenied(message(false)), true);
  assert.equal(approvalDenied(message(true)), false);
  assert.equal(approvalDenied({ role: 'assistant', parts: [] }), false);
  assert.equal(
    approvalDenied({ role: 'assistant', parts: [{ type: 'tool-x', state: 'output-available' }] }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Worker-level behaviour: segments, phases and reason codes on real runs.

test('a completed run records its queue wait, announces starting, and stamps completed', async (t) => {
  // The live phases are announced on the stream as the run works: the
  // 'starting' chunk is visible to the drive itself, before the step's end
  // prunes the resume buffer. The terminal announce survives the prune, so a
  // reconnecting client still learns the final outcome.
  let phasesAtDrive;
  const { worker, queue } = await harness(t, async ({ emit }) => {
    phasesAtDrive = worker.store
      .eventsAfter('r1', -1)
      .map((e) => e.payload)
      .filter((p) => p.type === 'data-run-phase')
      .map((p) => p.data.phase);
    emit({ type: 'text-delta', text: 'hello', id: 'a1' });
  });
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'done');
  assert.equal(run.reason_code, 'completed');

  const segments = timeline(worker, 'r1');
  const queueWait = segments.find((s) => s.segment === 'queue_wait');
  assert.ok(queueWait, 'a queue_wait segment is recorded at claim');
  assert.ok(queueWait.durationMs >= 0);

  assert.ok(
    phasesAtDrive.includes('starting'),
    'the starting phase is announced on the stream before the drive runs',
  );
  const done = eventPayloads(worker, 'r1').find(
    (p) => p.type === 'data-run-phase' && p.data.phase === 'done',
  );
  assert.ok(done, 'the terminal phase survives the resume-buffer prune');
  assert.equal(done.data.reasonCode, 'completed');
});

test('the worker drive context gives drives a working telemetry helper', async (t) => {
  let seen;
  const { worker, queue } = await harness(t, async ({ telemetry }) => {
    seen = telemetry;
    telemetry.recordSegment('mcp_handshake', 12);
    telemetry.phase('connecting-tools');
  });
  queue('r1');
  await worker.tick();
  assert.ok(seen, 'drives receive a telemetry object');
  const phases = eventPayloads(worker, 'r1').map((p) => p.type);
  assert.ok(phases.includes('data-run-phase'), 'telemetry.phase emits a phase chunk');
  const handshake = timeline(worker, 'r1').find((s) => s.segment === 'mcp_handshake');
  assert.equal(handshake.durationMs, 12, 'drive-recorded segments land in run_telemetry');
});

test('cancelling before the start stamps cancelled as the reason', async (t) => {
  let drives = 0;
  const { worker, queue } = await harness(t, async () => {
    drives += 1;
  });
  queue('r1');
  assert.equal(worker.cancel('r1'), true);
  assert.equal(await worker.tick(), null);
  assert.equal(drives, 0);
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.reason_code, 'cancelled');
  const payloads = eventPayloads(worker, 'r1').filter((p) => p.type === 'data-run-phase');
  assert.deepEqual(
    payloads.map((p) => p.data.phase),
    ['cancelled'],
    'the cancellation phase is announced with its reason code',
  );
  assert.equal(payloads[0].data.reasonCode, 'cancelled');
});

test('a budget-exhausted drive records budget-exhausted, not a generic failure', async (t) => {
  const { worker, queue } = await harness(t, async () => {
    throw new BudgetExhaustedError('step 4 over the cap');
  });
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.equal(run.reason_code, 'budget-exhausted');
});

test('a provider timeout and a provider error get their own reason codes', async (t) => {
  const { worker, queue } = await harness(t, async () => {
    const timeout = new Error('free queue is busy');
    timeout.name = 'FirstByteTimeout';
    throw timeout;
  });
  queue('r1');
  await worker.tick();
  assert.equal(worker.store.getRun('r1').reason_code, 'timeout');

  const second = await harness(t, async () => {
    throw new Error('the provider exploded with a 503');
  });
  second.queue('r2');
  await second.worker.tick();
  assert.equal(second.worker.store.getRun('r2').reason_code, 'provider-error');
});

test('a plain bug in the run records internal-error', async (t) => {
  const { worker, queue } = await harness(t, async () => {
    throw new TypeError('cannot read property of undefined');
  });
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.equal(run.reason_code, 'internal-error');
});

test('a run that answers nothing is recorded as no-answer', async (t) => {
  const { worker, queue } = await harness(t, async () => ({ silent: true }));
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'failed');
  assert.equal(run.reason_code, 'no-answer');
  const done = eventPayloads(worker, 'r1').find(
    (p) => p.type === 'data-run-phase' && p.data.phase === 'failed',
  );
  assert.equal(done.data.reasonCode, 'no-answer');
});

test('a run paused on an approval stamps awaiting-approval', async (t) => {
  const { worker, queue } = await harness(t, async () => ({ awaitingApproval: true }));
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.reason_code, 'awaiting-approval');
});

test('a run paused on a question stamps awaiting-answer', async (t) => {
  const { worker, queue } = await harness(t, async () => ({ awaitingClient: true }));
  queue('r1');
  await worker.tick();
  const run = worker.store.getRun('r1');
  assert.equal(run.status, 'waiting_client');
  assert.equal(run.reason_code, 'awaiting-answer');
});

// ---------------------------------------------------------------------------
// Red team: nothing secret ever lands in the telemetry tables or the stream.

test('telemetry rows and phase chunks never carry secrets', async (t) => {
  const fakeKey = 'sk-ant-fake-telemetry-redteam-12345';
  const fakeSecret = 'ghost-secret-telemetry-redteam-67890';
  const { worker, db, queue } = await harness(t, async ({ emit }) => {
    emit({ type: 'text-delta', text: 'a real answer', id: 'a1' });
  });
  // The run's config really does hold secret-shaped values — the test is
  // that none of them leaks out through the telemetry surface.
  queue('r1', {
    instructions: `Answer using the key ${fakeKey}`,
    model: 'x',
    extra: { token: fakeSecret },
  });
  worker.store.recordSegment('r1', 'preparation', 50);
  worker.store.recordSegment('r1', 'mcp_handshake', 10);
  worker.store.setReasonCode('r1', 'completed');
  await worker.tick();

  const rows = db
    .prepare('SELECT segment, duration_ms, reason_code FROM run_telemetry WHERE run_id = ?')
    .all('r1');
  assert.ok(rows.length >= 2, 'telemetry rows exist to inspect');
  assert.equal(JSON.stringify(rows).includes(fakeKey), false);
  assert.equal(JSON.stringify(rows).includes(fakeSecret), false);

  const run = worker.store.getRun('r1');
  assert.equal(run.config.includes(fakeKey), true, 'sanity: the secrets really are in the config');
  assert.equal(String(run.reason_code).includes(fakeKey), false);

  const payloads = eventPayloads(worker, 'r1');
  assert.ok(payloads.length > 0, 'stream events exist to inspect');
  for (const payload of payloads) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes(fakeKey), false, `leak in ${payload.type}`);
    assert.equal(text.includes(fakeSecret), false, `leak in ${payload.type}`);
  }
});
