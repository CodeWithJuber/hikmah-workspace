import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMS,
  ARM_CALL_CAP,
  TERMINAL_STATES,
  validatePlan,
  agreement,
} from '../lib/workflow/arms.ts';

test('arm call caps match the v5 table verbatim', () => {
  assert.deepEqual(ARM_CALL_CAP, {
    local: 0,
    direct: 1,
    'verify-repair': 3,
    decompose: 8,
    'explore-consensus': 6,
  });
  assert.deepEqual(
    [...ARMS],
    ['local', 'direct', 'verify-repair', 'decompose', 'explore-consensus'],
  );
});

test('terminal states are explicit and exhaustive', () => {
  assert.deepEqual(
    [...TERMINAL_STATES],
    ['cancelled', 'timeout', 'credential_failure', 'budget_exhausted', 'completed', 'failed'],
  );
});

test('a valid decompose plan passes', () => {
  // Depth 2: leaves (depth 1) -> merge nodes (depth 2). 4 leaves, 8 calls = cap.
  const v = validatePlan('decompose', [
    { id: 'a', dependsOn: [], plannedCalls: 2 },
    { id: 'b', dependsOn: [], plannedCalls: 2 },
    { id: 'c', dependsOn: ['a', 'b'], plannedCalls: 2 },
    { id: 'd', dependsOn: ['a'], plannedCalls: 2 },
  ]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('cyclic plans are rejected before execution', () => {
  const v = validatePlan('decompose', [
    { id: 'a', dependsOn: ['c'], plannedCalls: 1 },
    { id: 'b', dependsOn: ['a'], plannedCalls: 1 },
    { id: 'c', dependsOn: ['b'], plannedCalls: 1 },
  ]);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.includes('cycle')),
    JSON.stringify(v.errors),
  );
});

test('self-dependency is rejected', () => {
  const v = validatePlan('direct', [{ id: 'a', dependsOn: ['a'], plannedCalls: 1 }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('itself')));
});

test('over-budget plans are rejected before execution', () => {
  // direct is capped at 1 call; planning 2 must fail up front, not mid-run.
  const v = validatePlan('direct', [
    { id: 'a', dependsOn: [], plannedCalls: 1 },
    { id: 'b', dependsOn: [], plannedCalls: 1 },
  ]);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.includes('capped at 1')),
    JSON.stringify(v.errors),
  );
});

test('a plan exactly at cap passes', () => {
  const v = validatePlan('verify-repair', [
    { id: 'draft', dependsOn: [], plannedCalls: 1 },
    { id: 'check', dependsOn: ['draft'], plannedCalls: 1 },
    { id: 'repair', dependsOn: ['check'], plannedCalls: 1 },
  ]);
  assert.equal(v.ok, true);
});

test('local arm rejects any planned remote call', () => {
  const v = validatePlan('local', [{ id: 'a', dependsOn: [], plannedCalls: 1 }]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('capped at 0')));
});

test('decompose structural limits: 4 leaves, depth 2', () => {
  const five = validatePlan(
    'decompose',
    [1, 2, 3, 4, 5].map((i) => ({ id: `l${i}`, dependsOn: [], plannedCalls: 1 })),
  );
  assert.equal(five.ok, false);
  assert.ok(five.errors.some((e) => e.includes('at most 4 leaves')));

  const deep = validatePlan('decompose', [
    { id: 'a', dependsOn: [], plannedCalls: 1 },
    { id: 'b', dependsOn: ['a'], plannedCalls: 1 },
    { id: 'c', dependsOn: ['b'], plannedCalls: 1 },
  ]);
  assert.equal(deep.ok, false);
  assert.ok(
    deep.errors.some((e) => e.includes('depth')),
    JSON.stringify(deep.errors),
  );
});

test('unknown dependencies and duplicate ids are rejected', () => {
  const v = validatePlan('decompose', [
    { id: 'a', dependsOn: ['ghost'], plannedCalls: 1 },
    { id: 'a', dependsOn: [], plannedCalls: 1 },
  ]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('unknown leaf ghost')));
  assert.ok(v.errors.some((e) => e.includes('duplicate leaf id')));
});

test('empty plans are rejected', () => {
  const v = validatePlan('direct', []);
  assert.equal(v.ok, false);
});

test('agreement is descriptive, not P(correct)', () => {
  // 2 of 3 candidates agree -> 2/3 descriptive agreement. The label is
  // deliberate: same-model lanes may share a blind spot.
  assert.equal(agreement(2, 3), 2 / 3);
  assert.equal(agreement(3, 3), 1);
  assert.equal(agreement(0, 3), 0);
  assert.equal(agreement(2, 0), 0); // no candidates: 0 by convention
  assert.equal(agreement(9, 3), 1); // clamped, never > 1
});
