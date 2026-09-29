import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../lib/workflow/budget.ts';

const BUDGET = { maxCalls: 2, maxTokens: 100, maxCost: 5, deadlineMs: 60_000 };

test('calls within budget return null', () => {
  const ledger = createLedger(BUDGET);
  assert.equal(ledger.spendCall(10, 0.1), null);
  assert.equal(ledger.spendCall(10, 0.1), null);
  assert.equal(ledger.isExhausted(), null);
  // Read usage() once: two separate calls can straddle a millisecond tick
  // and flake the deepEqual on elapsedMs (PR-04 gate hit).
  const usage = ledger.usage();
  assert.deepEqual(usage, {
    calls: 2,
    maxCalls: 2,
    tokens: 20,
    maxTokens: 100,
    cost: 0.2,
    maxCost: 5,
    elapsedMs: usage.elapsedMs,
    deadlineMs: 60_000,
  });
});

test('exceeding maxCalls surfaces budget_exhausted (never as success)', () => {
  const ledger = createLedger(BUDGET);
  ledger.spendCall();
  ledger.spendCall();
  assert.equal(ledger.spendCall(), 'budget_exhausted');
  // Stays exhausted: no silent recovery.
  assert.equal(ledger.isExhausted(), 'budget_exhausted');
  assert.equal(ledger.usage().calls, 3);
});

test('a retry consumes budget like any other call', () => {
  const ledger = createLedger({ ...BUDGET, maxCalls: 1 });
  assert.equal(ledger.spendCall(), null); // first attempt
  // One invalid-JSON retry: the retry is a second call -> exhausted.
  assert.equal(ledger.spendCall(), 'budget_exhausted');
});

test('hidden-reasoning tokens count via spendCall and spendTokens', () => {
  const ledger = createLedger(BUDGET);
  assert.equal(ledger.spendCall(60, 0), null);
  assert.equal(ledger.spendTokens(30), null);
  assert.equal(ledger.spendTokens(11), 'budget_exhausted'); // 101 > 100
  assert.equal(ledger.usage().tokens, 101);
});

test('cost exhaustion surfaces budget_exhausted', () => {
  const ledger = createLedger(BUDGET);
  assert.equal(ledger.spendCall(0, 5), null);
  assert.equal(ledger.spendCall(0, 0.01), 'budget_exhausted');
});

test('deadline passing surfaces timeout', () => {
  let t = 0;
  const ledger = createLedger(
    { maxCalls: 100, maxTokens: 1e9, maxCost: 1e9, deadlineMs: 100 },
    { startTimeMs: 0, now: () => t },
  );
  t = 99;
  assert.equal(ledger.isExhausted(), null);
  t = 100;
  assert.equal(ledger.isExhausted(), 'timeout');
  // A spend attempted after the deadline reports timeout, not a spend.
  assert.equal(ledger.spendCall(), 'timeout');
  assert.equal(ledger.usage().calls, 0);
});

test('negative spends are rejected', () => {
  const ledger = createLedger(BUDGET);
  assert.throws(() => ledger.spendCall(-1), /non-negative/);
  assert.throws(() => ledger.spendTokens(-5), /non-negative/);
});
