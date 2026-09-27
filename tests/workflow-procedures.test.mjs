import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCEDURE_SIZE_PENALTY,
  procedureObjective,
  runProcedure,
  testProcedure,
  enumerateProcedures,
  bestProcedure,
  pruneWithCounterexample,
  promoteProcedure,
  isProcedureEligible,
  listPromotedProcedureIds,
  resetPromotedProcedures,
} from '../lib/workflow/procedures.ts';

// Toy task: count the people older than 30.
const EXAMPLES = [
  {
    input: [
      { name: 'a', age: 25 },
      { name: 'b', age: 35 },
      { name: 'c', age: 40 },
    ],
    expected: 2,
  },
  { input: [{ name: 'd', age: 20 }], expected: 0 },
  {
    input: [
      { name: 'e', age: 31 },
      { name: 'f', age: 30 },
    ],
    expected: 1,
  },
];

const COUNT_OVER_30 = {
  id: 'over30',
  ops: [{ op: 'filter', where: { kind: 'gt', path: 'age', value: 30 } }, { op: 'count' }],
};

test('runProcedure executes the DSL', () => {
  assert.equal(runProcedure(COUNT_OVER_30, EXAMPLES[0].input), 2);
  assert.equal(runProcedure(COUNT_OVER_30, EXAMPLES[1].input), 0);
  assert.equal(runProcedure(COUNT_OVER_30, EXAMPLES[2].input), 1);
  // Other ops.
  assert.equal(
    runProcedure({ id: 't', ops: [{ op: 'sum', path: 'age' }] }, EXAMPLES[0].input),
    100,
  );
  assert.equal(
    runProcedure({ id: 't', ops: [{ op: 'mean', path: 'age' }] }, EXAMPLES[0].input),
    100 / 3,
  );
  assert.deepEqual(runProcedure({ id: 't', ops: [{ op: 'first' }] }, EXAMPLES[0].input), {
    name: 'a',
    age: 25,
  });
  assert.equal(runProcedure({ id: 't', ops: [{ op: 'first' }] }, []), null);
  assert.equal(runProcedure({ id: 't', ops: [{ op: 'mean', path: 'age' }] }, []), 0);
  // Type errors throw (they become test failures, never silent wrong answers).
  assert.throws(
    () =>
      runProcedure(
        { id: 't', ops: [{ op: 'filter', where: { kind: 'gt', path: 'age', value: 1 } }] },
        42,
      ),
    /not an array/,
  );
});

test('testProcedure reports pass/fail with failures', () => {
  const ok = testProcedure(COUNT_OVER_30, EXAMPLES);
  assert.equal(ok.passed, true);
  assert.equal(ok.accuracy, 1);
  assert.deepEqual(ok.failures, []);
  const wrong = testProcedure({ id: 'w', ops: [{ op: 'count' }] }, EXAMPLES);
  assert.equal(wrong.passed, false);
  assert.equal(wrong.accuracy, 0); // counts 3/1/2 vs expected 2/0/1
  assert.equal(wrong.failures.length, 3);
});

test('enumerateProcedures finds a correct procedure on the toy task', () => {
  const found = enumerateProcedures({ examples: EXAMPLES, maxOps: 3 });
  assert.ok(found.length >= 1, 'expected at least one procedure');
  // J(p) ranks the shortest correct procedure first: [filter, count].
  assert.equal(found[0].ops.length, 2);
  assert.equal(found[0].ops[0].op, 'filter');
  assert.equal(found[0].ops[1].op, 'count');
  assert.equal(testProcedure(found[0], EXAMPLES).passed, true);
  // Deterministic: same task -> same enumeration.
  const again = enumerateProcedures({ examples: EXAMPLES, maxOps: 3 });
  assert.deepEqual(again, found);
});

test('bestProcedure picks argmax J(p)', () => {
  const best = bestProcedure(
    [{ id: 'long', ops: [...COUNT_OVER_30.ops, { op: 'first' }, { op: 'count' }] }, COUNT_OVER_30],
    EXAMPLES,
  );
  // 'long' fails (extra ops change the answer); the 2-op procedure wins.
  assert.equal(best.id, 'over30');
  assert.equal(bestProcedure([{ id: 'w', ops: [{ op: 'count' }] }], EXAMPLES), null);
});

test('J(p) = accuracy - lambda_size * |p|: shorter wins ties', () => {
  assert.ok(procedureObjective(1, 2) > procedureObjective(1, 3));
  assert.ok(procedureObjective(1, 3) > procedureObjective(0.5, 2));
  assert.equal(PROCEDURE_SIZE_PENALTY, 0.01);
});

test('pruneWithCounterexample kills refuted procedures', () => {
  const candidates = [{ id: 'count-all', ops: [{ op: 'count' }] }, COUNT_OVER_30];
  const pruned = pruneWithCounterexample(candidates, EXAMPLES[0]); // expected 2
  assert.deepEqual(
    pruned.map((p) => p.id),
    ['over30'],
  );
  // A counterexample consistent with both keeps both.
  const kept = pruneWithCounterexample(candidates, { input: [], expected: 0 });
  assert.equal(kept.length, 2);
});

test('promotion requires the dev-gate: refused when the gate fails', () => {
  resetPromotedProcedures();
  const refused = promoteProcedure({ procedure: COUNT_OVER_30, gateCheck: () => false });
  assert.equal(refused.promoted, false);
  assert.match(refused.reason, /dev-gate/i);
  assert.equal(isProcedureEligible('over30'), false);
});

test('promotion refused when the gate throws', () => {
  resetPromotedProcedures();
  const refused = promoteProcedure({
    procedure: COUNT_OVER_30,
    gateCheck: () => {
      throw new Error('gate exploded');
    },
  });
  assert.equal(refused.promoted, false);
  assert.equal(isProcedureEligible('over30'), false);
});

test('promoted procedures become eligible for the local arm', () => {
  resetPromotedProcedures();
  assert.equal(isProcedureEligible('over30'), false);
  const res = promoteProcedure({ procedure: COUNT_OVER_30, gateCheck: () => true });
  assert.equal(res.promoted, true);
  assert.equal(isProcedureEligible('over30'), true);
  assert.deepEqual(listPromotedProcedureIds(), ['over30']);
});
