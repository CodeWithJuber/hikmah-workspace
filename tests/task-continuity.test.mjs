// Task continuity (PR-16b): the reload-safe rules for background learning tasks.
// Pure logic — no database, no worker — so every behavior here is pinned
// without fixtures.
// Run: node --test tests/task-continuity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continueTask,
  ensurePrompt,
  isPendingRunStatus,
  recordOutcome,
  replaceOutcome,
  resolvePrompt,
} from '../lib/tasks/continuity.ts';

const NOW = '2026-09-30T04:00:00.000Z';

// ---------------------------------------------------------------------------
// continueTask: rebind while pending, never dispatch a duplicate.
// ---------------------------------------------------------------------------

test('a pending run re-binds on reload — queued, running, and both paused states', () => {
  for (const status of ['queued', 'running', 'waiting_approval', 'waiting_client']) {
    assert.ok(isPendingRunStatus(status), status);
    const decision = continueTask({
      activeRunId: 'run-1',
      activeStatus: status,
      lastRunId: 'run-1',
      lastStatus: status,
    });
    assert.deepEqual(decision, { action: 'rebind', runId: 'run-1', status });
  }
});

test('a finished run settles: the reload reads the report, dispatches nothing', () => {
  for (const status of ['done', 'failed', 'cancelled']) {
    const decision = continueTask({
      activeRunId: null,
      activeStatus: null,
      lastRunId: 'run-9',
      lastStatus: status,
    });
    assert.deepEqual(decision, { action: 'settled', runId: 'run-9', status });
  }
});

test('no run on record is none — and there is no start-while-pending outcome', () => {
  assert.deepEqual(
    continueTask({ activeRunId: null, activeStatus: null, lastRunId: null, lastStatus: null }),
    { action: 'none' },
  );
  // The decision type has no "dispatch a new run" arm: while a run is
  // pending, continue can only rebind. Enumerate the arms to pin that.
  const pending = continueTask({
    activeRunId: 'run-1',
    activeStatus: 'running',
    lastRunId: null,
    lastStatus: null,
  });
  assert.equal(pending.action, 'rebind');
});

test('a corrupt active read (id without a pending status) falls back to the last run', () => {
  const decision = continueTask({
    activeRunId: 'run-ghost',
    activeStatus: 'done',
    lastRunId: 'run-8',
    lastStatus: 'failed',
  });
  assert.deepEqual(decision, { action: 'settled', runId: 'run-8', status: 'failed' });
});

test('non-pending statuses are not pending', () => {
  for (const status of ['done', 'failed', 'cancelled', null, undefined, '']) {
    assert.equal(isPendingRunStatus(status), false);
  }
});

// ---------------------------------------------------------------------------
// ensurePrompt / resolvePrompt: ask once.
// ---------------------------------------------------------------------------

test('the first ask creates the prompt and audits it', () => {
  const { prompts, prompt, created } = ensurePrompt(
    [],
    { id: 'p1', question: 'Which region?', options: ['a', 'b'] },
    NOW,
  );
  assert.equal(created, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompt?.id, 'p1');
  assert.equal(prompt?.resolvedAt, null);
});

test('asking the same prompt again returns the same one — a reload does not re-prompt', () => {
  const first = ensurePrompt([], { id: 'p1', question: 'Which region?' }, NOW);
  const second = ensurePrompt(first.prompts, { id: 'p1', question: 'Which region?' }, NOW);
  assert.equal(second.created, false);
  assert.equal(second.prompts.length, 1);
  assert.equal(second.prompt?.id, 'p1');
  assert.equal(second.prompt?.createdAt, NOW);
});

test('a resolved prompt is never asked again', () => {
  const { prompts } = ensurePrompt([], { id: 'p1', question: 'Which region?' }, NOW);
  const resolved = resolvePrompt(prompts, 'p1', 'EMEA', 'user-1', NOW);
  assert.equal(resolved.ok, true);
  const again = ensurePrompt(resolved.prompts, { id: 'p1', question: 'Which region?' }, NOW);
  assert.equal(again.created, false);
  assert.equal(again.prompt, null);
  assert.equal(again.prompts.length, 1);
});

test('distinct prompt ids coexist', () => {
  const first = ensurePrompt([], { id: 'p1', question: 'One?' }, NOW);
  const second = ensurePrompt(first.prompts, { id: 'p2', question: 'Two?' }, NOW);
  assert.equal(second.created, true);
  assert.equal(second.prompts.length, 2);
});

test('resolving an unknown prompt fails rather than inventing one', () => {
  const result = resolvePrompt([], 'nope', 'x', 'user-1', NOW);
  assert.deepEqual(result, { ok: false, error: 'unknown-prompt' });
});

test('a double-submitted answer resolves once — the retry is absorbed', () => {
  const { prompts } = ensurePrompt([], { id: 'p1', question: 'Which region?' }, NOW);
  const first = resolvePrompt(prompts, 'p1', 'EMEA', 'user-1', NOW);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('unreachable');
  assert.equal(first.alreadyResolved, false);
  const second = resolvePrompt(first.prompts, 'p1', 'APAC', 'user-1', NOW);
  assert.equal(second.ok, true);
  if (!second.ok) throw new Error('unreachable');
  assert.equal(second.alreadyResolved, true);
  // The first answer stands; the retry did not overwrite it.
  assert.equal(second.prompt.resolution, 'EMEA');
  assert.equal(second.prompt.resolvedBy, 'user-1');
});

// ---------------------------------------------------------------------------
// recordOutcome / replaceOutcome: never silently replaced.
// ---------------------------------------------------------------------------

test('the first outcome records with an audit entry', () => {
  const { outcome, audit } = recordOutcome(
    null,
    { status: 'done', summary: 'Learned X.', runId: 'run-1' },
    'user-1',
    NOW,
  );
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.summary, 'Learned X.');
  assert.equal(outcome.recordedBy, 'user-1');
  assert.equal(audit.action, 'outcome_recorded');
  assert.equal(audit.actor, 'user-1');
});

test('a second recordOutcome throws — replacement needs the explicit path', () => {
  const { outcome } = recordOutcome(
    null,
    { status: 'done', summary: 'First.', runId: 'run-1' },
    'user-1',
    NOW,
  );
  assert.throws(
    () => recordOutcome(outcome, { status: 'failed', summary: 'Second.' }, 'user-1', NOW),
    /replaceOutcome/,
  );
});

test('replaceOutcome without explicit:true is refused', () => {
  const { outcome } = recordOutcome(
    null,
    { status: 'done', summary: 'First.', runId: 'run-1' },
    'user-1',
    NOW,
  );
  for (const opts of [{ actor: 'user-1' }, { actor: 'user-1', explicit: false }]) {
    const result = replaceOutcome(outcome, { status: 'failed', summary: 'Second.' }, opts, NOW);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.match(result.error, /explicit/);
  }
  // Refused means untouched.
  assert.equal(outcome.summary, 'First.');
});

test('an explicit replacement swaps the outcome and leaves an audit entry', () => {
  const { outcome: first } = recordOutcome(
    null,
    { status: 'done', summary: 'First.', runId: 'run-1' },
    'user-1',
    NOW,
  );
  const result = replaceOutcome(
    first,
    { status: 'failed', summary: 'Second.' },
    { actor: 'user-1', explicit: true, reason: 'The report was wrong.' },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.outcome.summary, 'Second.');
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.audit.action, 'outcome_replaced');
  assert.equal(result.audit.actor, 'user-1');
  assert.deepEqual(result.audit.detail.reason, 'The report was wrong.');
  assert.deepEqual(result.audit.detail.from.summary, 'First.');
  assert.deepEqual(result.audit.detail.to.summary, 'Second.');
});

test('replaceOutcome with no current outcome records (nothing to silently replace)', () => {
  const result = replaceOutcome(
    null,
    { status: 'done', summary: 'Only.' },
    { actor: 'user-1', explicit: true },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.audit.action, 'outcome_replaced');
  assert.equal(result.audit.detail.from, null);
});
