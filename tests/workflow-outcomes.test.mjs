import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME_LABELS,
  BETA,
  outcomeKey,
  assertObserved,
  recordOutcome,
  outcomeDistribution,
  stateValue,
  rankContinuations,
} from '../lib/workflow/outcomes.ts';

const S = {
  taskCategory: 'qa',
  interpretationKnown: true,
  evidenceAvailable: false,
  failureObserved: false,
};

test('outcomeKey canonicalizes the state abstraction', () => {
  assert.equal(outcomeKey(S), 'qa|i:1|e:0|f:0');
  assert.equal(
    outcomeKey({
      taskCategory: 'a|b',
      interpretationKnown: false,
      evidenceAvailable: true,
      failureObserved: true,
    }),
    'a/b|i:0|e:1|f:1',
  );
});

test('beta priors: no observations -> uniform (small-sample uncertainty)', () => {
  const d = outcomeDistribution({}, S, 'direct');
  assert.deepEqual(Object.keys(d).sort(), [...OUTCOME_LABELS].sort());
  for (const o of OUTCOME_LABELS) assert.equal(d[o], 1 / 3);
  assert.equal(d.verified_success + d.verified_failure + d.unknown, 1);
});

test('T(o|s,a) = (N+beta)/(sum N + sum beta), hand-computed', () => {
  // 2 verified successes for direct: T = (2+1)/5, (0+1)/5, (0+1)/5.
  let counts = {};
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  const d = outcomeDistribution(counts, S, 'direct');
  assert.equal(d.verified_success, 3 / 5);
  assert.equal(d.verified_failure, 1 / 5);
  assert.equal(d.unknown, 1 / 5);
  // A different (state, arm) pair is unaffected: prior mass keeps it eligible.
  const other = outcomeDistribution(counts, S, 'local');
  assert.equal(other.verified_success, 1 / 3);
});

test('recordOutcome is immutable', () => {
  const before = {};
  const after = recordOutcome(before, S, 'direct', 'verified_failure');
  assert.deepEqual(before, {});
  assert.equal(after[`${outcomeKey(S)}::direct`].verified_failure, 1);
});

test('predicted outcomes are NEVER counted', () => {
  // Runtime label gate in recordOutcome.
  assert.throws(() => recordOutcome({}, S, 'direct', 'predicted_success'), /never counted/);
  // assertObserved: the gate every observation must pass first.
  assert.throws(
    () => assertObserved({ label: 'predicted_success', verificationId: 'v', verifiedAt: 't' }),
    /never counted/,
  );
  assert.throws(() => assertObserved({ label: 'verified_success' }), /verificationId/);
  assert.throws(
    () => assertObserved({ label: 'verified_success', verificationId: 'v' }),
    /verifiedAt/,
  );
  assert.throws(() => assertObserved(null), /must be an object/);
  // A genuine verified observation passes.
  assertObserved({
    label: 'verified_success',
    verificationId: 'check-123',
    verifiedAt: '2026-09-28T00:00:00Z',
  });
});

test('rankContinuations implements V_h, hand-computed (horizon 1)', () => {
  // direct: 2 verified successes -> T = {0.6, 0.2, 0.2}.
  // reward: success=1, failure=0, unknown=0.2.
  // Q(direct) = 0.6*1 + 0.2*0 + 0.2*0.2 = 0.64.
  // local: no counts -> uniform prior -> Q = (1+0+0.2)/3 = 0.4.
  let counts = {};
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  const model = {
    gamma: 0.9,
    horizon: 1,
    reward: (s, a, o) => (o === 'verified_success' ? 1 : o === 'unknown' ? 0.2 : 0),
    next: () => null,
  };
  const ranked = rankContinuations(counts, S, ['direct', 'local'], model);
  assert.equal(ranked[0].arm, 'direct');
  assert.ok(Math.abs(ranked[0].value - 0.64) < 1e-12, String(ranked[0].value));
  assert.equal(ranked[1].arm, 'local');
  assert.ok(Math.abs(ranked[1].value - 0.4) < 1e-12, String(ranked[1].value));
});

test('terminal states contribute zero continuation', () => {
  let counts = {};
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  const reward = (s, a, o) => (o === 'verified_success' ? 1 : 0);
  const h1 = rankContinuations(counts, S, ['direct'], {
    gamma: 0.9,
    horizon: 1,
    reward,
    next: () => null,
  });
  const h2 = rankContinuations(counts, S, ['direct'], {
    gamma: 0.9,
    horizon: 2,
    reward,
    next: () => null,
  });
  // next() -> null everywhere: horizon 2 adds no continuation value.
  assert.ok(Math.abs(h1[0].value - h2[0].value) < 1e-12);
});

test('V_h recurses with discount, hand-computed (horizon 2)', () => {
  // s0: direct has 2 successes -> T0 = {0.6, 0.2, 0.2}.
  // On verified_success, next -> s1 (non-terminal); else terminal (null).
  // s1: direct has 1 success -> T1 = {0.5, 0.25, 0.25}, all next -> null.
  // reward: success=1, failure=0, unknown=0.2. gamma=0.5.
  // V_1(s1) = 0.5*1 + 0.25*0 + 0.25*0.2 = 0.55.
  // Q_2(s0,direct) = 0.6*(1 + 0.5*0.55) + 0.2*0 + 0.2*0.2
  //                = 0.6*1.275 + 0.04 = 0.805.
  const S1 = { ...S, taskCategory: 'qa2' };
  let counts = {};
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  counts = recordOutcome(counts, S, 'direct', 'verified_success');
  counts = recordOutcome(counts, S1, 'direct', 'verified_success');
  const model = {
    gamma: 0.5,
    horizon: 2,
    reward: (s, a, o) => (o === 'verified_success' ? 1 : o === 'unknown' ? 0.2 : 0),
    next: (s, a, o) => (o === 'verified_success' && s.taskCategory === 'qa' ? S1 : null),
  };
  const v = stateValue(counts, S, ['direct'], model, 2);
  assert.ok(Math.abs(v - 0.805) < 1e-12, String(v));
  // Horizon 0 and empty arms: V = 0.
  assert.equal(stateValue(counts, S, ['direct'], model, 0), 0);
  assert.equal(stateValue(counts, S, [], model, 2), 0);
});

test('BETA constants exported', () => {
  assert.deepEqual(BETA, { verified_success: 1, verified_failure: 1, unknown: 1 });
});
