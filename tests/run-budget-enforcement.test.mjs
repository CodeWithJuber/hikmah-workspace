// PR-04: run budgets enforced at dispatch, across retries and lanes.
//
// These tests observe ACTUAL provider dispatches (counted inside the scripted
// model's doStream, through the real wrapLanguageModel middleware) and the
// PERSISTED budget row — not mocks of the budget helper. The pure ledger math
// already has tests/workflow-budget.test.mjs; this file is the execution path.
//
// Run: node --test tests/run-budget-enforcement.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentUIStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { applySchema } from './schema.mjs';
import { createRunBudgetLedger } from '../lib/workflow/ledger.ts';
import { withRunBudget, BudgetExhaustedError } from '../lib/ai/budget-middleware.ts';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const BUDGET = { maxCalls: 2, maxTokens: 1000, maxCost: 10, deadlineMs: 60_000 };

function freshDb(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  return db;
}

function persistedRow(db, runId) {
  return db.prepare('SELECT spent_json, state FROM run_budget_ledger WHERE run_id = ?').get(runId);
}

const usage = (input, output) => ({
  inputTokens: { total: input },
  outputTokens: { total: output },
});

const textChunks = (text, u) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: u },
];

/** A scripted provider that counts REAL doStream dispatches. Each entry is
 * either chunk list or an Error the provider throws. */
function scriptedModel(entries) {
  let dispatches = 0;
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      dispatches += 1;
      const next = entries[Math.min(step++, entries.length - 1)];
      if (next instanceof Error) throw next;
      return {
        stream: simulateReadableStream({
          chunks: next,
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      };
    },
  });
  return { model, dispatches: () => dispatches };
}

/** Drive one doStream dispatch to completion and drain it. doStream is the
 * actual dispatch boundary: the mock counts a dispatch only when the real
 * middleware calls through to the real model. */
async function driveStream(wrapped, prompt = 'x') {
  const result = await wrapped.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });
  const reader = result.stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  reader.releaseLock();
}

function driveText(wrapped, prompt) {
  return driveStream(wrapped, prompt);
}

test('a zero-call budget dispatches nothing and persists budget_exhausted', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_zero', { ...BUDGET, maxCalls: 0 });
  const { model, dispatches } = scriptedModel([textChunks('hi', usage(10, 5))]);
  const wrapped = withRunBudget(model, ledger);

  await assert.rejects(driveText(wrapped, 'hi'), (error) => {
    assert.ok(error instanceof BudgetExhaustedError);
    assert.equal(error.terminalState, 'budget_exhausted');
    assert.match(error.message, /budget exhausted/);
    assert.match(error.message, /run_zero/);
    return true;
  });
  assert.equal(dispatches(), 0);
  assert.equal(ledger.snapshot().spent.calls, 0);
  assert.equal(ledger.snapshot().state, 'budget_exhausted');
  const row = persistedRow(db, 'run_zero');
  assert.equal(JSON.parse(row.spent_json).calls, 0);
  assert.equal(row.state, 'budget_exhausted');
});

test('dispatches settle actual usage; the next dispatch stops at the cap', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_seq', { ...BUDGET, maxCalls: 1 });
  const { model, dispatches } = scriptedModel([
    textChunks('one', usage(100, 50)),
    textChunks('two', usage(10, 10)),
  ]);
  const wrapped = withRunBudget(model, ledger);

  await driveText(wrapped, 'one');
  assert.equal(dispatches(), 1);
  assert.deepEqual(ledger.snapshot().spent, { calls: 1, tokens: 150, cost: 0 });

  await assert.rejects(driveText(wrapped, 'two'), BudgetExhaustedError);
  assert.equal(dispatches(), 1); // nothing more went out

  const row = persistedRow(db, 'run_seq');
  assert.deepEqual(JSON.parse(row.spent_json), { calls: 1, tokens: 150, cost: 0 });
});

test('token exhaustion stops the next dispatch before it goes out', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_tok', {
    maxCalls: 10,
    maxTokens: 100,
    maxCost: 10,
    deadlineMs: 60_000,
  });
  const { model, dispatches } = scriptedModel([
    textChunks('big', usage(90, 20)), // 110 > 100: this call still goes out…
    textChunks('more', usage(1, 1)), // …but this one must not.
  ]);
  const wrapped = withRunBudget(model, ledger);

  await driveText(wrapped, 'big');
  assert.equal(ledger.snapshot().spent.tokens, 110);
  await assert.rejects(driveText(wrapped, 'more'), (error) => {
    assert.ok(error instanceof BudgetExhaustedError);
    assert.match(error.message, /110\/100 tokens/);
    return true;
  });
  assert.equal(dispatches(), 1);
});

test('concurrent lanes share one budget: no over-dispatch under races', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_race', { ...BUDGET, maxCalls: 2 });
  const { model, dispatches } = scriptedModel([textChunks('lane', usage(10, 5))]);
  const wrapped = withRunBudget(model, ledger);

  const attempts = Array.from({ length: 5 }, (_, i) =>
    driveText(wrapped, 'lane ' + i)
      .then(() => 'ok')
      .catch((error) => error),
  );
  const outcomes = await Promise.all(attempts);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 2);
  assert.equal(outcomes.filter((o) => o instanceof BudgetExhaustedError).length, 3);
  assert.equal(dispatches(), 2);
  assert.equal(ledger.snapshot().spent.calls, 2);
  assert.equal(JSON.parse(persistedRow(db, 'run_race').spent_json).calls, 2);
});

test('a dispatch with no usage settles conservatively, never zero', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_unknown', BUDGET);
  const noUsage = [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'shrug' },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop' } }, // no usage at all
  ];
  const { model, dispatches } = scriptedModel([noUsage]);
  await driveText(withRunBudget(model, ledger), 'x');

  assert.equal(dispatches(), 1);
  const snap = ledger.snapshot();
  assert.equal(snap.spent.calls, 1);
  // 5% of maxTokens, floored at 1: an unknown cost is not a free call.
  assert.equal(snap.spent.tokens, Math.ceil(1000 * 0.05));
  assert.ok(snap.spent.tokens > 0);
});

test('a usage object reporting nothing usable also settles conservatively', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_empty_usage', BUDGET);
  const emptyUsage = textChunks('x', { inputTokens: {}, outputTokens: {} });
  const { model } = scriptedModel([emptyUsage]);
  const wrapped = withRunBudget(model, ledger);
  await driveText(wrapped, 'x');
  assert.ok(ledger.snapshot().spent.tokens > 0);
});

test('a failed dispatch releases its reservation: not charged, retry allowed', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_fail', { ...BUDGET, maxCalls: 1 });
  const { model, dispatches } = scriptedModel([
    new Error('provider exploded'),
    textChunks('recovered', usage(10, 5)),
  ]);
  const wrapped = withRunBudget(model, ledger);

  await assert.rejects(driveText(wrapped, 'x'), /provider exploded/);
  assert.equal(dispatches(), 1);
  // The failed dispatch was released, not settled: no call charged, no
  // reservation left dangling.
  assert.deepEqual(ledger.snapshot().spent, { calls: 0, tokens: 0, cost: 0 });
  assert.equal(ledger.snapshot().reserved, 0);

  // The retry is a new dispatch with its own reserve: it goes out and settles.
  await driveText(wrapped, 'x');
  assert.equal(dispatches(), 2);
  assert.equal(ledger.snapshot().spent.calls, 1);
});

test('a resumed run sees the same durable budget state, not a fresh one', async (t) => {
  const db = freshDb(t);
  const first = createRunBudgetLedger(db, 'run_resume', { ...BUDGET, maxCalls: 1 });
  const s1 = scriptedModel([textChunks('first', usage(20, 10))]);
  await driveText(withRunBudget(s1.model, first), 'x');
  assert.equal(first.snapshot().spent.calls, 1);

  // "Restart": a brand-new ledger instance over the same row — and a LARGER
  // budget passed in, to prove the stored one wins over a fresh one.
  const second = createRunBudgetLedger(db, 'run_resume', {
    ...BUDGET,
    maxCalls: 99,
    maxTokens: 99999,
  });
  assert.equal(second.snapshot().spent.calls, 1);
  assert.equal(second.snapshot().budget.maxCalls, 1);

  const s2 = scriptedModel([textChunks('second', usage(1, 1))]);
  await assert.rejects(driveText(withRunBudget(s2.model, second), 'x'), BudgetExhaustedError);
  assert.equal(s2.dispatches(), 0);
});

test('aborting a stream releases the reservation without charging', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_abort', { ...BUDGET, maxCalls: 1 });
  const partial = [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'partial' },
    // No finish part: the consumer gives up mid-stream.
  ];
  const { model, dispatches } = scriptedModel([partial]);
  const wrapped = withRunBudget(model, ledger);
  const result = await wrapped.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  });
  const reader = result.stream.getReader();
  await reader.read();
  await reader.cancel();
  reader.releaseLock();

  assert.equal(dispatches(), 1);
  assert.equal(ledger.snapshot().spent.calls, 0);
  assert.equal(ledger.snapshot().reserved, 0);

  // The freed capacity is usable again by the next dispatch.
  const s2 = scriptedModel([textChunks('again', usage(5, 5))]);
  await driveStream(withRunBudget(s2.model, ledger), 'x');
  assert.equal(ledger.snapshot().spent.calls, 1);
  assert.equal(ledger.snapshot().spent.tokens, 10);
});

test('a passed deadline surfaces timeout, not budget_exhausted', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_timeout', { ...BUDGET, deadlineMs: 0 });
  assert.deepEqual(ledger.reserve(), { ok: false, state: 'timeout' });

  const { model, dispatches } = scriptedModel([textChunks('x', usage(1, 1))]);
  await assert.rejects(driveText(withRunBudget(model, ledger), 'x'), (error) => {
    assert.ok(error instanceof BudgetExhaustedError);
    assert.equal(error.terminalState, 'timeout');
    assert.match(error.message, /deadline exceeded/);
    return true;
  });
  assert.equal(dispatches(), 0);
  assert.equal(persistedRow(db, 'run_timeout').state, 'timeout');
});

test('onExhausted gives callers the typed signal when the guard refuses', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_signal', { ...BUDGET, maxCalls: 0 });
  const { model } = scriptedModel([textChunks('x', usage(1, 1))]);
  const seen = [];
  await assert.rejects(
    driveText(withRunBudget(model, ledger, { onExhausted: (e) => seen.push(e) }), 'x'),
    BudgetExhaustedError,
  );
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof BudgetExhaustedError);
  assert.equal(seen[0].runId, 'run_signal');
});

test('the agent loop stops before the second step: one dispatch, explicit signal', async (t) => {
  const db = freshDb(t);
  const ledger = createRunBudgetLedger(db, 'run_agent', { ...BUDGET, maxCalls: 1 });
  const toolCallChunks = [
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'run_javascript',
      input: JSON.stringify({ code: '1+1' }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls' }, usage: usage(30, 10) },
  ];
  const { model, dispatches } = scriptedModel([
    toolCallChunks,
    textChunks('two', usage(10, 10)), // never reached: the budget is spent
  ]);
  const seen = [];
  const agent = buildRunAgent({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    model: withRunBudget(model, ledger, { onExhausted: (e) => seen.push(e) }),
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
    maxSteps: 5,
  });
  const stream = await createAgentUIStream({
    agent,
    uiMessages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'compute 1+1' }] }],
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  // Exactly one provider dispatch went out; the loop ended on the explicit
  // exhaustion (an error chunk), not a silent stop.
  assert.equal(dispatches(), 1);
  assert.ok(
    chunks.some((c) => c.type === 'error'),
    'expected an error chunk',
  );
  assert.equal(ledger.snapshot().spent.calls, 1);
  assert.equal(ledger.snapshot().spent.tokens, 40);
  // The typed signal the run service uses to record the explicit terminal
  // state instead of a generic failure.
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof BudgetExhaustedError);
  assert.equal(seen[0].terminalState, 'budget_exhausted');
});
