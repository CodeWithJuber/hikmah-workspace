// PR-10: workflow dispatch — every selectable arm genuinely executes its
// declared steps and call cap, through the PR-04 budget reservations.
//
// Fail-before proof: this file imports ../lib/workflow/dispatch.ts, which did
// not exist before PR-10 — the arms were selectable (policy/enqueue) with no
// execution behind them. The phantom-arm probe below documents that directly.
// Run: node --test tests/workflow-dispatch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createRunBudgetLedger } from '../lib/workflow/ledger.ts';
import { ARM_CALL_CAP, ARMS } from '../lib/workflow/arms.ts';
import { eligibleArms } from '../lib/workflow/policy.ts';
import { DISPATCHABLE_ARMS, dispatchArm } from '../lib/workflow/dispatch.ts';

const BUDGET = { maxCalls: 100, maxTokens: 1_000_000, maxCost: 10_000, deadlineMs: 60_000 };

function harness(t, budget = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(() => db.close());
  const ledger = createRunBudgetLedger(db, 'run1', { ...BUDGET, ...budget });
  return { db, ledger };
}

/** Scripted fake provider: one response per call, in order. Errors throw. */
function scriptedProvider(script) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const next = script[calls.length - 1];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('scriptedProvider: script exhausted');
    return next;
  };
  fn.calls = calls;
  return fn;
}

const resp = (text, usage) => ({ text, usage: usage ?? { inputTokens: 10, outputTokens: 20 } });
const clean = (id = 'check-1') => ({ checkId: id, defects: [] });
const defective = (defects, id = 'check-1') => ({ checkId: id, defects });

// ---------------------------------------------------------------------------
// The contract: no selectable-but-fake arm.
// ---------------------------------------------------------------------------

test('contract: every selectable arm is dispatchable (no phantom options)', () => {
  assert.deepEqual([...DISPATCHABLE_ARMS].sort(), [...ARMS].sort());
});

test('phantom-arm probe: verify-repair is selectable AND has an executor', async (t) => {
  // eligibleArms already offered verify-repair before PR-10; the executor is
  // what was missing. This guards the regression both ways.
  const eligible = eligibleArms({
    hasProviderKey: true,
    local: null,
    budget: { maxCalls: 8, maxTokens: 1000, maxCost: 10, deadlineMs: 60000 },
  });
  assert.ok(eligible.includes('verify-repair'));
  assert.ok(DISPATCHABLE_ARMS.includes('verify-repair'));

  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('draft')]);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: '2+2?',
    ledger,
    hooks: { callProvider, verify: async () => clean() },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.calls, 1); // clean draft: no phantom repair call
  assert.equal(callProvider.calls.length, 1);
});

// ---------------------------------------------------------------------------
// direct
// ---------------------------------------------------------------------------

test('direct: one call, reserve+settle through the PR-04 ledger', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('the answer')]);
  const result = await dispatchArm({
    arm: 'direct',
    prompt: 'hi',
    ledger,
    hooks: { callProvider },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.result, 'the answer');
  assert.equal(result.calls, 1);
  assert.equal(callProvider.calls[0].purpose, 'generate');
  const snap = ledger.snapshot();
  assert.equal(snap.spent.calls, 1);
  assert.equal(snap.spent.tokens, 30); // actual usage settled, not a guess
  assert.equal(snap.reserved, 0);
});

test('direct: budget exhausted → no provider call, explicit terminal', async (t) => {
  const { ledger } = harness(t, { maxCalls: 0 });
  let called = false;
  const result = await dispatchArm({
    arm: 'direct',
    prompt: 'hi',
    ledger,
    hooks: {
      callProvider: async () => {
        called = true;
        return resp('x');
      },
    },
  });
  assert.equal(result.terminal, 'budget_exhausted');
  assert.equal(called, false);
  assert.equal(result.calls, 0);
});

test('direct: deadline hit → timeout terminal, no dispatch', async (t) => {
  const { ledger } = harness(t, { deadlineMs: 0 });
  let called = false;
  const result = await dispatchArm({
    arm: 'direct',
    prompt: 'hi',
    ledger,
    hooks: {
      callProvider: async () => {
        called = true;
        return resp('x');
      },
    },
  });
  assert.equal(result.terminal, 'timeout');
  assert.equal(called, false);
});

test('direct: provider throws mid-arm → failed, reservation released (not charged)', async (t) => {
  const { ledger } = harness(t);
  const boom = new Error('provider exploded');
  const result = await dispatchArm({
    arm: 'direct',
    prompt: 'hi',
    ledger,
    hooks: { callProvider: scriptedProvider([boom]) },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /provider exploded/);
  const snap = ledger.snapshot();
  assert.equal(snap.spent.calls, 0); // the failed dispatch is not charged
  assert.equal(snap.reserved, 0);
});

test('direct: credential-shaped failure → credential_failure terminal', async (t) => {
  const { ledger } = harness(t);
  const err = new Error('unauthorized: bad api key');
  err.code = 'credential_failure';
  const result = await dispatchArm({
    arm: 'direct',
    prompt: 'hi',
    ledger,
    hooks: { callProvider: scriptedProvider([err]) },
  });
  assert.equal(result.terminal, 'credential_failure');
});

// ---------------------------------------------------------------------------
// verify-repair
// ---------------------------------------------------------------------------

test('verify-repair: draft → independent check finds defects → targeted repair → clean', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('draft v1'), resp('draft v2 fixed')]);
  const seen = [];
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider,
      verify: async (candidate) => {
        seen.push(candidate);
        return candidate.includes('fixed') ? clean() : defective(['unsupported claim']);
      },
    },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.result, 'draft v2 fixed');
  assert.equal(result.calls, 2);
  assert.deepEqual(
    callProvider.calls.map((c) => c.purpose),
    ['generate', 'repair'],
  );
  // The independent check genuinely ran — on both candidates, in order.
  assert.deepEqual(seen, ['draft v1', 'draft v2 fixed']);
  // Pre-repair candidate is preserved, not overwritten.
  assert.equal(result.preRepairResult, 'draft v1');
  assert.equal(result.checks.length, 2);
  assert.deepEqual(result.defects, []);
  // Repair prompt names the defects (targeted, not a blind rewrite).
  assert.match(callProvider.calls[1].prompt, /unsupported claim/);
});

test('verify-repair: clean draft → no repair call (cap is a cap, not a quota)', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('already good')]);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: { callProvider, verify: async () => clean() },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.calls, 1);
  assert.equal(result.result, 'already good');
});

test('verify-repair: call cap enforced — stops at 3 calls with defects disclosed', async (t) => {
  const { ledger } = harness(t); // maxCalls 100: only the arm cap binds
  const callProvider = scriptedProvider([resp('d0'), resp('d1'), resp('d2'), resp('d3')]);
  const defectsByCandidate = { d0: ['a', 'b', 'c'], d1: ['a', 'b'], d2: ['a'], d3: [] };
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider,
      verify: async (candidate) => defective(defectsByCandidate[candidate] ?? ['?']),
    },
  });
  assert.equal(result.calls, ARM_CALL_CAP['verify-repair']);
  assert.ok(result.calls <= 3);
  assert.equal(callProvider.calls.length, 3); // d3 never generated: cap hit first
  assert.equal(result.terminal, 'completed');
  assert.deepEqual(result.defects, ['a']); // remaining defect disclosed, not hidden
  assert.equal(result.result, 'd2'); // best independently-measured candidate kept
});

test('verify-repair: no independently measured improvement → stop, keep pre-repair', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('draft'), resp('worse')]);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider,
      verify: async (candidate) =>
        candidate === 'draft' ? defective(['x']) : defective(['y', 'z']),
    },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.calls, 2); // one repair attempted, then stopped
  assert.equal(result.result, 'draft'); // pre-repair preserved: revision damaged it
  assert.equal(result.preRepairResult, 'draft');
  assert.deepEqual(result.defects, ['x']);
});

test('verify-repair: budget exhausted mid-arm → stops, repair never attempted', async (t) => {
  const { ledger } = harness(t, { maxCalls: 1 });
  const callProvider = scriptedProvider([resp('draft'), resp('repaired')]);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: { callProvider, verify: async () => defective(['needs work']) },
  });
  assert.equal(result.terminal, 'budget_exhausted');
  assert.equal(result.calls, 1);
  assert.equal(callProvider.calls.length, 1); // generate only; no repair dispatched
  assert.deepEqual(result.defects, ['needs work']);
});

test('verify-repair: provider throws during repair → failed, failed call not charged', async (t) => {
  const { ledger } = harness(t);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider: scriptedProvider([resp('draft'), new Error('repair exploded')]),
      verify: async () => defective(['needs work']),
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.equal(ledger.snapshot().spent.calls, 1); // only the generate is charged
  assert.equal(ledger.snapshot().reserved, 0);
});

test('verify-repair: missing verifier → refuses, never silently runs as direct', async (t) => {
  const { ledger } = harness(t);
  let called = false;
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider: async () => {
        called = true;
        return resp('x');
      },
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /independent verifier/);
  assert.equal(called, false); // refused BEFORE any provider call
  assert.equal(result.calls, 0);
});

test('verify-repair: verifier throwing → failed (a broken check never passes)', async (t) => {
  const { ledger } = harness(t);
  const result = await dispatchArm({
    arm: 'verify-repair',
    prompt: 'write it',
    ledger,
    hooks: {
      callProvider: scriptedProvider([resp('draft')]),
      verify: async () => {
        throw new Error('check infrastructure down');
      },
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /check infrastructure down/);
});

// ---------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------

const twoLeafPlan = [
  { id: 'a', dependsOn: [], plannedCalls: 1 },
  { id: 'b', dependsOn: ['a'], plannedCalls: 2 },
];

test('decompose: leaves execute in dependency order, plannedCalls honored, merged', async (t) => {
  const { ledger } = harness(t);
  const order = [];
  const callProvider = scriptedProvider([resp('out-a'), resp('out-b1'), resp('out-b2')]);
  const result = await dispatchArm({
    arm: 'decompose',
    prompt: 'big task',
    ledger,
    hooks: {
      callProvider,
      plan: twoLeafPlan,
      leafPrompt: (leaf, depOutputs) => {
        if (order[order.length - 1] !== leaf.id) order.push(leaf.id);
        return `leaf ${leaf.id} after ${JSON.stringify(depOutputs)}`;
      },
      mergeLeaves: (outputs) => `merged(${outputs.a}|${outputs.b})`,
    },
  });
  assert.equal(result.terminal, 'completed');
  assert.deepEqual(order, ['a', 'b']); // dependent leaf waited for validated output
  assert.equal(result.calls, 3);
  assert.equal(result.result, 'merged(out-a|out-b1,out-b2)');
  // Leaf b saw leaf a's output.
  assert.match(callProvider.calls[1].prompt, /"a":\["out-a"\]/);
});

test('decompose: cyclic plan rejected BEFORE execution — provider never called', async (t) => {
  const { ledger } = harness(t);
  let called = false;
  const result = await dispatchArm({
    arm: 'decompose',
    prompt: 'big task',
    ledger,
    hooks: {
      callProvider: async () => {
        called = true;
        return resp('x');
      },
      plan: [
        { id: 'a', dependsOn: ['b'], plannedCalls: 1 },
        { id: 'b', dependsOn: ['a'], plannedCalls: 1 },
      ],
      leafPrompt: () => 'p',
      mergeLeaves: (o) => JSON.stringify(o),
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /cycle/);
  assert.equal(called, false);
  assert.equal(result.calls, 0);
});

test('decompose: over-budget plan rejected before execution', async (t) => {
  const { ledger } = harness(t);
  let called = false;
  const result = await dispatchArm({
    arm: 'decompose',
    prompt: 'big task',
    ledger,
    hooks: {
      callProvider: async () => {
        called = true;
        return resp('x');
      },
      plan: [
        { id: 'a', dependsOn: [], plannedCalls: 5 },
        { id: 'b', dependsOn: [], plannedCalls: 5 },
      ],
      leafPrompt: () => 'p',
      mergeLeaves: (o) => JSON.stringify(o),
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /capped at 8/);
  assert.equal(called, false);
});

test('decompose: budget exhausted mid-plan → stops, later leaves never run', async (t) => {
  const { ledger } = harness(t, { maxCalls: 2 });
  const callProvider = scriptedProvider([resp('out-a'), resp('out-b1'), resp('out-b2')]);
  const ran = [];
  const result = await dispatchArm({
    arm: 'decompose',
    prompt: 'big task',
    ledger,
    hooks: {
      callProvider,
      plan: twoLeafPlan,
      leafPrompt: (leaf) => {
        ran.push(leaf.id);
        return 'p';
      },
      mergeLeaves: (o) => JSON.stringify(o),
    },
  });
  assert.equal(result.terminal, 'budget_exhausted');
  assert.equal(result.calls, 2);
  assert.ok(!ran.includes('b') || callProvider.calls.length === 2);
  assert.equal(callProvider.calls.length, 2); // third call never dispatched
});

test('decompose: missing plan → refuses with an explicit reason', async (t) => {
  const { ledger } = harness(t);
  const result = await dispatchArm({
    arm: 'decompose',
    prompt: 'big task',
    ledger,
    hooks: { callProvider: scriptedProvider([resp('x')]) },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /plan/);
});

// ---------------------------------------------------------------------------
// explore-consensus
// ---------------------------------------------------------------------------

test('explore-consensus: 3 independent candidates, compare, synthesize, agreement descriptive', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([
    resp('Paris'),
    resp('Paris'),
    resp('London'),
    resp('synthesis: Paris'),
  ]);
  const result = await dispatchArm({
    arm: 'explore-consensus',
    prompt: 'capital of France?',
    ledger,
    hooks: {
      callProvider,
      verify: async (candidate) =>
        candidate === 'London' ? defective(['wrong capital']) : clean(),
    },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.calls, 4); // 3 candidates + 1 synthesis, within the cap of 6
  assert.deepEqual(
    callProvider.calls.map((c) => c.purpose),
    ['candidate', 'candidate', 'candidate', 'synthesize'],
  );
  assert.equal(result.result, 'synthesis: Paris');
  // Substantive disagreement is preserved, not forced into unanimity.
  assert.deepEqual(result.candidates, ['Paris', 'Paris', 'London']);
  // agreement = 2/3, descriptive — the largest cluster over candidates.
  assert.equal(result.agreement, 2 / 3);
  // 3 candidate checks + 1 synthesis check — the compare step genuinely ran.
  assert.equal(result.checks.length, 4);
});

test('explore-consensus: never exceeds its call cap', async (t) => {
  const { ledger } = harness(t); // maxCalls 100: only the arm cap binds
  const script = Array.from({ length: 10 }, (_, i) => resp(`c${i}`));
  const callProvider = scriptedProvider(script);
  const result = await dispatchArm({
    arm: 'explore-consensus',
    prompt: 'open question',
    ledger,
    hooks: {
      callProvider,
      verify: async () => defective(['still bad']), // repair path also exercised
    },
  });
  assert.ok(result.calls <= ARM_CALL_CAP['explore-consensus']);
  assert.ok(callProvider.calls.length <= 6);
});

test('explore-consensus: works without a verifier (compare = cluster + agreement)', async (t) => {
  const { ledger } = harness(t);
  const callProvider = scriptedProvider([resp('a'), resp('a'), resp('b'), resp('synth')]);
  const result = await dispatchArm({
    arm: 'explore-consensus',
    prompt: 'q',
    ledger,
    hooks: { callProvider },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.agreement, 2 / 3);
  assert.deepEqual(result.checks, []);
});

// ---------------------------------------------------------------------------
// local
// ---------------------------------------------------------------------------

test('local: zero remote calls, zero ledger interaction', async (t) => {
  const { ledger } = harness(t);
  let providerCalled = false;
  const result = await dispatchArm({
    arm: 'local',
    prompt: 'count these',
    ledger,
    hooks: {
      callProvider: async () => {
        providerCalled = true;
        return resp('x');
      },
      localExecute: async (prompt) => `local-result(${prompt})`,
    },
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.result, 'local-result(count these)');
  assert.equal(result.calls, 0);
  assert.equal(providerCalled, false);
  const snap = ledger.snapshot();
  assert.equal(snap.spent.calls, 0);
  assert.equal(snap.reserved, 0);
});

test('local: missing executor → explicit failure, not a silent direct call', async (t) => {
  const { ledger } = harness(t);
  let providerCalled = false;
  const result = await dispatchArm({
    arm: 'local',
    prompt: 'count these',
    ledger,
    hooks: {
      callProvider: async () => {
        providerCalled = true;
        return resp('x');
      },
    },
  });
  assert.equal(result.terminal, 'failed');
  assert.match(result.error, /localExecute/);
  assert.equal(providerCalled, false);
});

// ---------------------------------------------------------------------------
// defensive
// ---------------------------------------------------------------------------

test('unknown arm → throws (programming error, not a run outcome)', async (t) => {
  const { ledger } = harness(t);
  await assert.rejects(
    () =>
      dispatchArm({
        arm: 'not-an-arm',
        prompt: 'x',
        ledger,
        hooks: { callProvider: scriptedProvider([]) },
      }),
    /unknown workflow arm/,
  );
});
