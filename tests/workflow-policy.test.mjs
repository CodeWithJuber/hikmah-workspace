import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_VERSION,
  FEATURE_DIM,
  LAMBDA,
  LAMBDA_COST,
  LAMBDA_TIME,
  initialPolicyState,
  serializePolicyState,
  deserializePolicyState,
  extractFeatures,
  eligibleArms,
  selectArm,
  policyUpdate,
} from '../lib/workflow/policy.ts';

// ---------------------------------------------------------------------------
// Hand-computed LinUCB fixture (dim 2; the implementation is dim-agnostic).
//
// Initial: A = I, b = 0 for every arm (lambda = 1).
//
// Update 1: arm=direct, x=[1,0], quality=1, cost=0, budget=100,
//           latencyMs=0, deadlineMs=1000, w=1
//   q=1, costFrac=0, latFrac=0  ->  r = 1 - 0.5*0 - 0.3*0 = 1
//   A <- I + 1*[1,0]'[1,0] = [[2,0],[0,1]]
//   b <- [0,0] + 1*[1,0]*1 = [1,0]
//
// Update 2: arm=direct, x=[0,1], quality=1, cost=50, budget=100,
//           latencyMs=250, deadlineMs=1000, w=0.5
//   q=1, costFrac=min(50/100,1)=0.5, latFrac=min(250/1000,1)=0.25
//   r = 1 - 0.5*0.5 - 0.3*0.25 = 1 - 0.25 - 0.075 = 0.675
//   A <- [[2,0],[0,1]] + 0.5*[[0,0],[0,1]] = [[2,0],[0,1.5]]
//   b <- [1,0] + 0.5*[0,1]*0.675 = [1, 0.3375]
//
// By hand:  A^-1 = [[1/2,0],[0,2/3]]  (diagonal: invert the entries)
//           theta = A^-1 b = [0.5*1, (2/3)*0.3375] = [0.5, 0.225]
//
// Score for x=[1,0], alpha=1:
//   mean = theta'x = 0.5*1 + 0.225*0 = 0.5
//   A^-1 x = [0.5, 0];  x'(A^-1 x) = 0.5
//   score = 0.5 + sqrt(0.5)
// ---------------------------------------------------------------------------

const ARMS2 = ['local', 'direct', 'verify-repair', 'decompose', 'explore-consensus'];

function dim2State() {
  const arms = {};
  for (const arm of ARMS2)
    arms[arm] = {
      A: [
        [1, 0],
        [0, 1],
      ],
      b: [0, 0],
    };
  return { version: FEATURE_VERSION, arms };
}

function learnedState() {
  let s = dim2State();
  const r1 = policyUpdate(s, {
    id: 'fb1',
    arm: 'direct',
    x: [1, 0],
    quality: 1,
    cost: 0,
    budget: 100,
    latencyMs: 0,
    deadlineMs: 1000,
    weight: 1,
  });
  assert.equal(r1.applied, true);
  const r2 = policyUpdate(r1.state, {
    id: 'fb2',
    arm: 'direct',
    x: [0, 1],
    quality: 1,
    cost: 50,
    budget: 100,
    latencyMs: 250,
    deadlineMs: 1000,
    weight: 0.5,
  });
  assert.equal(r2.applied, true);
  return { s1: r1.state, s2: r2.state, r2 };
}

test('constants', () => {
  assert.equal(FEATURE_VERSION, 1);
  assert.equal(FEATURE_DIM, 10);
  assert.equal(LAMBDA, 1);
  assert.equal(LAMBDA_COST, 0.5);
  assert.equal(LAMBDA_TIME, 0.3);
});

test('initialPolicyState: A = lambda*I, b = 0', () => {
  const s = initialPolicyState();
  assert.equal(s.version, FEATURE_VERSION);
  for (const arm of ARMS2) {
    const { A, b } = s.arms[arm];
    assert.equal(A.length, FEATURE_DIM);
    assert.equal(b.length, FEATURE_DIM);
    assert.ok(b.every((v) => v === 0));
    for (let i = 0; i < FEATURE_DIM; i++)
      for (let j = 0; j < FEATURE_DIM; j++) assert.equal(A[i][j], i === j ? LAMBDA : 0);
  }
});

test('policyUpdate math: A += w*x*xT, b += w*x*r (hand-computed)', () => {
  const { s1, s2, r2 } = learnedState();
  // After update 1.
  assert.deepEqual(s1.arms.direct.A, [
    [2, 0],
    [0, 1],
  ]);
  assert.deepEqual(s1.arms.direct.b, [1, 0]);
  // After update 2.
  assert.deepEqual(s2.arms.direct.A, [
    [2, 0],
    [0, 1.5],
  ]);
  assert.deepEqual(s2.arms.direct.b, [1, 0.5 * (1 - 0.5 * 0.5 - 0.3 * 0.25)]);
  // Other arms untouched.
  assert.deepEqual(s2.arms.local.A, [
    [1, 0],
    [0, 1],
  ]);
  // Reward breakdown keeps components visible separately.
  assert.deepEqual(r2.reward, {
    total: 1 - 0.5 * 0.5 - 0.3 * 0.25,
    quality: 1,
    cost: 0.5,
    latency: 0.25,
  });
  // Immutability: update 1's state is unchanged by update 2.
  assert.deepEqual(s1.arms.direct.A, [
    [2, 0],
    [0, 1],
  ]);
});

test('selectArm scores match the hand-computed LinUCB values', () => {
  const { s2 } = learnedState();
  const eligible = ['direct', 'verify-repair', 'decompose'];
  const sel = selectArm(eligible, [1, 0], s2, { epsilon: 0, rng: () => 0.5 });
  // direct: learned arm. theta=[0.5, 0.225], score = 0.5 + sqrt(0.5).
  const direct = sel.scores.find((s) => s.arm === 'direct');
  assert.equal(direct.isFallback, false);
  assert.equal(direct.score, 0.5 + Math.sqrt(0.5));
  // Untouched arms: sparse -> fallback prior, score 0.
  for (const s of sel.scores.filter((s) => s.arm !== 'direct')) {
    assert.equal(s.score, 0);
    assert.equal(s.isFallback, true);
  }
  // Scores sorted desc, include all eligible.
  assert.equal(sel.scores.length, 3);
  assert.ok(sel.scores[0].score >= sel.scores[1].score);
  assert.ok(sel.scores[1].score >= sel.scores[2].score);
  assert.equal(sel.arm, 'direct');
  assert.equal(sel.featureVersion, FEATURE_VERSION);
});

test('sparse feedback -> fallback prior identical to today: all tie at 0', () => {
  const s = initialPolicyState();
  const eligible = ['direct', 'verify-repair', 'decompose', 'explore-consensus'];
  const x = extractFeatures({
    prompt: 'summarize this',
    taskCategory: 'qa',
    constraintCount: 0,
    availableSources: 0,
    budget: { maxCalls: 8, maxTokens: 100, maxCost: 1, deadlineMs: 1000 },
    priorFailureTags: [],
    localCompetence: 0,
  });
  const sel = selectArm(eligible, x, s, { epsilon: 0, rng: () => 0.99 });
  assert.ok(sel.scores.every((sc) => sc.score === 0 && sc.isFallback));
  // Deterministic tie-break: first eligible in ARMS order ('direct' here,
  // exactly what the pipeline did before the policy existed).
  assert.equal(sel.arm, 'direct');
  assert.equal(sel.propensity, 1);
});

test('eligibility: local gated on co-model confidence, remote arms on key', () => {
  const budget = { maxCalls: 8, maxTokens: 100, maxCost: 1, deadlineMs: 1000 };
  // No key, no local frame: nothing eligible.
  assert.deepEqual(eligibleArms({ hasProviderKey: false, local: null, budget }), []);
  // Key only: the four remote arms, never local.
  assert.deepEqual(eligibleArms({ hasProviderKey: true, local: null, budget }), [
    'direct',
    'verify-repair',
    'decompose',
    'explore-consensus',
  ]);
  // Confident supported frame: local joins.
  assert.deepEqual(
    eligibleArms({
      hasProviderKey: true,
      local: { supported: true, confidence: 0.9, threshold: 0.8 },
      budget,
    })[0],
    'local',
  );
  // Below threshold: no local. Unsupported frame: no local.
  assert.ok(
    !eligibleArms({
      hasProviderKey: true,
      local: { supported: true, confidence: 0.5, threshold: 0.8 },
      budget,
    }).includes('local'),
  );
  assert.ok(
    !eligibleArms({
      hasProviderKey: true,
      local: { supported: false, confidence: 0.99, threshold: 0.8 },
      budget,
    }).includes('local'),
  );
  // The policy never overrides eligibility: even a learned state cannot
  // select an arm that is not in the eligible list.
  const { s2 } = learnedState();
  assert.throws(() => selectArm([], [1, 0], s2, { epsilon: 0, rng: () => 0 }), /no eligible arms/);
});

test('epsilon propensity: p(a|x) = epsilon/K + (1-epsilon)*1[a=best]', () => {
  const { s2 } = learnedState();
  const eligible = ['direct', 'verify-repair', 'decompose']; // K=3, best='direct'
  // Greedy (rng >= epsilon): chosen = best.
  const greedy = selectArm(eligible, [1, 0], s2, { epsilon: 0.3, rng: () => 0.99 });
  assert.equal(greedy.arm, 'direct');
  assert.equal(greedy.propensity, 0.3 / 3 + (1 - 0.3) * 1);
  // Explore: rng() = 0.1 < 0.3 -> uniform draw; second draw 0.99 -> idx 2.
  const seq = [0.1, 0.99];
  const explored = selectArm(eligible, [1, 0], s2, {
    epsilon: 0.3,
    rng: () => seq.shift(),
  });
  assert.equal(explored.arm, 'decompose');
  assert.equal(explored.propensity, 0.3 / 3 + (1 - 0.3) * 0);
  // epsilon = 0: always greedy, propensity 1.
  const det = selectArm(eligible, [1, 0], s2, { epsilon: 0, rng: () => 0.01 });
  assert.equal(det.arm, 'direct');
  assert.equal(det.propensity, 1);
});

test('seeded rng makes selection replayable', () => {
  const { s2 } = learnedState();
  const eligible = ['direct', 'verify-repair', 'decompose'];
  const mulberry = (seed) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = selectArm(eligible, [1, 0], s2, { epsilon: 0.5, rng: mulberry(42) });
  const b = selectArm(eligible, [1, 0], s2, { epsilon: 0.5, rng: mulberry(42) });
  assert.equal(a.arm, b.arm);
  assert.equal(a.propensity, b.propensity);
});

test('missing quality is NOT applied: missing rating != success', () => {
  const s = dim2State();
  const before = JSON.parse(JSON.stringify(s));
  const res = policyUpdate(s, {
    id: 'fb-missing',
    arm: 'direct',
    x: [1, 0],
    quality: null,
    cost: 10,
    budget: 100,
    latencyMs: 100,
    deadlineMs: 1000,
  });
  assert.equal(res.applied, false);
  assert.equal(res.reward, null);
  assert.deepEqual(s, before); // state untouched
});

test('policyUpdate validates inputs', () => {
  const s = dim2State();
  assert.throws(
    () =>
      policyUpdate(s, {
        id: 'x',
        arm: 'nope',
        x: [1, 0],
        quality: 1,
        cost: 0,
        budget: 1,
        latencyMs: 0,
        deadlineMs: 1,
      }),
    /unknown arm/,
  );
  assert.throws(
    () =>
      policyUpdate(s, {
        id: 'x',
        arm: 'direct',
        x: [1],
        quality: 1,
        cost: 0,
        budget: 1,
        latencyMs: 0,
        deadlineMs: 1,
      }),
    /feature dim/,
  );
});

test('serialize/deserialize round-trip; bad shapes throw', () => {
  const s = initialPolicyState();
  const back = deserializePolicyState(serializePolicyState(s));
  assert.deepEqual(back, s);
  assert.throws(() => deserializePolicyState('not json'), /invalid JSON/);
  assert.throws(() => deserializePolicyState('{"version":999,"arms":{}}'), /version/);
  assert.throws(
    () => deserializePolicyState(JSON.stringify({ version: 1, arms: {} })),
    /dimension|arm/,
  );
  const bad = JSON.parse(serializePolicyState(s));
  delete bad.arms.direct;
  assert.throws(() => deserializePolicyState(JSON.stringify(bad)), /direct/);
  const badNum = JSON.parse(serializePolicyState(s));
  badNum.arms.direct.b[0] = Infinity;
  assert.throws(() => deserializePolicyState(JSON.stringify(badNum)), /finite/);
});

test('extractFeatures: FEATURE_DIM heuristic features in [0,1], deterministic', () => {
  const ctx = {
    prompt: '```python\ndef f(x):\n    return x + 1\n```\ncompute the total for n=5',
    taskCategory: 'code',
    constraintCount: 3,
    availableSources: 2,
    budget: { maxCalls: 4, maxTokens: 100, maxCost: 1, deadlineMs: 1000 },
    priorFailureTags: ['timeout'],
    localCompetence: 0.7,
  };
  const f = extractFeatures(ctx);
  assert.equal(f.length, FEATURE_DIM);
  assert.ok(
    f.every((v) => v >= 0 && v <= 1),
    JSON.stringify(f),
  );
  assert.deepEqual(extractFeatures(ctx), f); // deterministic
  // Feature order (v1): [prompt_len, code, numeric, category, constraints,
  //   sources, budget, fail_count, fail_any, local_competence]
  assert.equal(f[1], 1); // code markers present
  assert.equal(f[2], 1); // digits in a quantitative context
  assert.equal(f[4], 0.3);
  assert.equal(f[5], 0.2);
  assert.equal(f[6], 0.5); // 4/8
  assert.equal(f[7], 0.2); // 1/5
  assert.equal(f[8], 1);
  assert.equal(f[9], 0.7);
  const plain = extractFeatures({ ...ctx, prompt: 'hello world', taskCategory: 'other' });
  assert.equal(plain[1], 0);
  assert.equal(plain[2], 0);
  assert.notEqual(plain[3], f[3]); // category hash differs
});
