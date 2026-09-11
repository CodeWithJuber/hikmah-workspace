import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  createPreset,
  plan,
  executePlan,
  validateProblem,
  transitionEstimate,
  rankActionsByInformation,
  selectContext,
  wordUnits,
  evaluateEvidence,
} from '../lib/engines/agent-math.ts';

const near = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const scope = { tenant: 't1', project: 'p1', context: 'c1' };
const query = { id: 'service:healthy', scope, eventTime: '2026-09-09T10:00:00Z' };
const assertion = (id, polarity, proposition = query, sourceRef = `source:${id}`) => ({
  id,
  polarity,
  proposition,
  sourceRef,
});

test('all three presets produce multi-step plans and verify their own simulated goals', () => {
  for (const id of Object.keys(PRESETS)) {
    const scenario = createPreset(id);
    const result = plan(scenario);
    assert.equal(result.status, 'found');
    assert.ok(result.trace.length >= 5);
    assert.equal(result.unresolvedGoals.length, 0);
    assert.equal(result.optimality, 'least_cost_in_configured_success_model');
    const execution = executePlan(scenario, result.actionIds);
    assert.equal(execution.status, 'goal_reached');
    assert.equal(execution.goalVerifiedInSimulation, true);
    assert.equal(execution.externalOperations, 0);
    assert.equal(execution.spent, result.totalCost);
  }
});

test('hosting path follows prerequisite order and carries simulated proof references', () => {
  const result = plan(createPreset('hosting'));
  assert.deepEqual(result.actionIds, [
    'inspect-logs',
    'diagnose',
    'backup',
    'repair',
    'restart',
    'check-health',
  ]);
  assert.equal(result.totalCost, 9);
  for (const step of result.trace) {
    assert.ok(step.preconditions.every((proof) => proof.satisfied && proof.references.length > 0));
    assert.ok(step.effectReferences.every((ref) => ref.startsWith('simulated:')));
  }
  assert.ok(result.goalProofs.every((proof) => proof.satisfied));
});

test('insufficient planning budget reports a blocker and does not claim a complete plan', () => {
  const result = plan({ ...createPreset('hosting'), budget: 8 });
  assert.equal(result.status, 'blocked');
  assert.ok(result.unresolvedGoals.length > 0);
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'budget'));
  assert.ok(result.totalCost <= 8);
});

test('revoked restart permission blocks planning without granting itself permission', () => {
  const base = createPreset('hosting');
  const problem = {
    ...base,
    permissions: base.permissions.filter((item) => item !== 'service.restart'),
  };
  const result = plan(problem);
  assert.equal(result.status, 'blocked');
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.kind === 'permission' && blocker.detail === 'service.restart',
    ),
  );
  assert.deepEqual(problem.permissions, ['logs.read', 'service.write', 'health.read']);
});

test('changing initial facts changes the required plan', () => {
  const base = createPreset('hosting');
  const result = plan({ ...base, initial: { ...base.initial, config_valid: true } });
  assert.deepEqual(result.actionIds, ['restart', 'check-health']);
  assert.equal(result.totalCost, 3);
});

test('uniform-cost search chooses the cheaper complete route and responds to cost changes', () => {
  const base = createPreset('document');
  const shortcut = {
    id: 'shortcut',
    label: 'Configured ready-made document',
    requires: [{ fact: 'brief_ready', value: true }],
    effects: [{ fact: 'delivered', value: true }],
    cost: 8,
    observations: { successes: 1, failures: 1 },
    modelRef: 'test:shortcut',
  };
  const normal = plan({ ...base, actions: [...base.actions, shortcut] });
  assert.equal(normal.totalCost, 7);
  assert.equal(normal.actionIds.includes('shortcut'), false);
  const cheaper = plan({ ...base, actions: [...base.actions, { ...shortcut, cost: 3 }] });
  assert.deepEqual(cheaper.actionIds, ['shortcut']);
  assert.equal(cheaper.totalCost, 3);
});

test('visited-state search terminates when actions cycle without satisfying a goal', () => {
  const base = createPreset('document');
  const cyclic = {
    ...base,
    initial: { ready: false, impossible: false },
    goals: [{ fact: 'impossible', value: true }],
    actions: [
      {
        id: 'on',
        label: 'on',
        requires: [{ fact: 'ready', value: false }],
        effects: [{ fact: 'ready', value: true }],
        cost: 1,
        observations: { successes: 0, failures: 0 },
        modelRef: 'test:on',
      },
      {
        id: 'off',
        label: 'off',
        requires: [{ fact: 'ready', value: true }],
        effects: [{ fact: 'ready', value: false }],
        cost: 1,
        observations: { successes: 0, failures: 0 },
        modelRef: 'test:off',
      },
    ],
    budget: 1000,
  };
  const result = plan(cyclic);
  assert.equal(result.status, 'blocked');
  assert.equal(result.uniqueStates, 2);
  assert.equal(result.expansions, 2);
});

test('expansion cap produces search_limit rather than proving unreachability', () => {
  const result = plan({ ...createPreset('hosting'), maxExpansions: 1 });
  assert.equal(result.status, 'search_limit');
  assert.equal(result.expansions, 1);
  assert.equal(result.optimality, 'not_established');
});

test('already satisfied goals require no simulated actions or spend', () => {
  const base = createPreset('hosting');
  const problem = {
    ...base,
    initial: { ...base.initial, service_healthy: true, health_checked: true },
    budget: 0,
  };
  const result = plan(problem);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.actionIds, []);
  assert.equal(executePlan(problem, []).status, 'goal_reached');
});

test('single-step simulation applies only the first transition', () => {
  const problem = createPreset('hosting');
  const execution = executePlan(problem, plan(problem).actionIds, { stepLimit: 1 });
  assert.equal(execution.status, 'step_limit');
  assert.equal(execution.trace.length, 1);
  assert.equal(execution.finalState.logs_reviewed, true);
  assert.equal(execution.finalState.fault_identified, false);
  assert.equal(execution.spent, 1);
});

test('configured repair failure incurs cost, halts simulation, and prevents goal claims', () => {
  const problem = createPreset('hosting');
  const execution = executePlan(problem, plan(problem).actionIds, {
    outcomes: { repair: 'failure' },
  });
  assert.equal(execution.status, 'failed');
  assert.equal(execution.trace.length, 4);
  assert.equal(execution.finalState.config_valid, false);
  assert.equal(execution.goalVerifiedInSimulation, false);
  assert.equal(execution.spent, 6);
  assert.equal(execution.trace.at(-1).outcome, 'failure');
});

test('verification failure overrides optimistic simulated health', () => {
  const problem = createPreset('hosting');
  const execution = executePlan(problem, plan(problem).actionIds, {
    outcomes: { 'check-health': 'failure' },
  });
  assert.equal(execution.finalState.service_healthy, false);
  assert.equal(execution.finalState.health_checked, false);
  assert.equal(execution.goalVerifiedInSimulation, false);
  assert.equal(execution.spent, 9);
});

test('a failed scenario can be explicitly replanned from its observed simulated state and remaining budget', () => {
  const base = { ...createPreset('hosting'), budget: 20 };
  const failed = executePlan(base, plan(base).actionIds, { outcomes: { repair: 'failure' } });
  const recovery = { ...base, initial: failed.finalState, budget: failed.remainingBudget };
  const result = plan(recovery);
  assert.deepEqual(result.actionIds, ['repair', 'restart', 'check-health']);
  assert.equal(executePlan(recovery, result.actionIds).goalVerifiedInSimulation, true);
});

test('execution rechecks permission and budget after a plan was constructed', () => {
  const base = createPreset('hosting');
  const ids = plan(base).actionIds;
  const revoked = executePlan({ ...base, permissions: [] }, ids);
  assert.equal(revoked.status, 'blocked');
  assert.equal(revoked.spent, 0);
  const shortBudget = executePlan({ ...base, budget: 2 }, ids);
  assert.equal(shortBudget.status, 'blocked');
  assert.equal(shortBudget.trace.length, 2);
});

test('out-of-order or unknown actions cannot bypass prerequisites', () => {
  const problem = createPreset('document');
  assert.equal(executePlan(problem, ['deliver']).status, 'blocked');
  assert.equal(executePlan(problem, ['unknown']).status, 'blocked');
  assert.equal(executePlan(problem, ['outline']).status, 'plan_exhausted');
});

test('validation rejects undeclared facts, contradictory effects, bad costs and invalid outcome keys', () => {
  const base = createPreset('document');
  assert.throws(
    () => validateProblem({ ...base, goals: [{ fact: 'invented', value: false }] }),
    /undeclared/,
  );
  assert.throws(
    () =>
      validateProblem({
        ...base,
        actions: [
          {
            ...base.actions[0],
            effects: [
              { fact: 'outline_ready', value: true },
              { fact: 'outline_ready', value: false },
            ],
          },
        ],
      }),
    /contradictory/,
  );
  assert.throws(
    () => validateProblem({ ...base, actions: [{ ...base.actions[0], cost: 0 }] }),
    /positive/,
  );
  assert.throws(() => executePlan(base, [], { outcomes: { absent: 'failure' } }), /Unknown/);
});

test('Beta(1,1) prior has derived mean, variance, entropy and expected variance reduction', () => {
  const estimate = transitionEstimate({ successes: 0, failures: 0 });
  near(estimate.mean, 0.5);
  near(estimate.variance, 1 / 12);
  near(estimate.expectedVarianceReduction, 1 / 36);
  near(estimate.predictiveEntropyBits, 1);
  assert.equal(estimate.status, 'prior_only');
});

test('Bayesian counts update the posterior and expected next variance matches both weighted outcomes', () => {
  const estimate = transitionEstimate({ successes: 8, failures: 2 });
  assert.equal(estimate.alpha, 9);
  assert.equal(estimate.beta, 3);
  near(estimate.mean, 0.75);
  const afterSuccess = transitionEstimate({ successes: 9, failures: 2 });
  const afterFailure = transitionEstimate({ successes: 8, failures: 3 });
  const expected =
    estimate.mean * afterSuccess.variance + (1 - estimate.mean) * afterFailure.variance;
  near(expected, estimate.expectedVarianceAfterOneObservation);
  near(estimate.variance - expected, estimate.expectedVarianceReduction);
});

test('information ranking considers evidence concentration and cost', () => {
  const template = createPreset('document').actions[0];
  const ranked = rankActionsByInformation([
    { ...template, id: 'known', cost: 1, observations: { successes: 50, failures: 50 } },
    { ...template, id: 'new-expensive', cost: 10, observations: { successes: 0, failures: 0 } },
    { ...template, id: 'new-cheap', cost: 1, observations: { successes: 0, failures: 0 } },
  ]);
  assert.deepEqual(
    ranked.map((row) => row.actionId),
    ['new-cheap', 'new-expensive', 'known'],
  );
});

test('invalid transition counts and prior parameters are rejected', () => {
  assert.throws(() => transitionEstimate({ successes: -1, failures: 0 }), /counts/);
  assert.throws(() => transitionEstimate({ successes: 0.5, failures: 0 }), /counts/);
  assert.throws(() => transitionEstimate({ successes: 1, failures: 0, priorAlpha: 0 }), /positive/);
});

test('four evidence states are computed from signed scoped assertions', () => {
  assert.equal(evaluateEvidence(query, []).state, 'unknown');
  assert.equal(evaluateEvidence(query, [assertion('a', 'positive')]).state, 'supported');
  assert.equal(evaluateEvidence(query, [assertion('b', 'negative')]).state, 'refuted');
  const conflict = evaluateEvidence(query, [
    assertion('a', 'positive'),
    assertion('b', 'negative'),
  ]);
  assert.equal(conflict.state, 'both');
  assert.equal(conflict.supporting.length, 1);
  assert.equal(conflict.refuting.length, 1);
});

test('tenant, project, context, time and proposition differences prevent accidental evidence merging', () => {
  const others = [
    { ...query, scope: { ...scope, tenant: 't2' } },
    { ...query, scope: { ...scope, project: 'p2' } },
    { ...query, scope: { ...scope, context: 'c2' } },
    { ...query, eventTime: '2026-09-10T10:00:00Z' },
    { ...query, id: 'service:restarted' },
  ];
  const result = evaluateEvidence(
    query,
    others.map((proposition, index) => assertion(`x${index}`, 'positive', proposition)),
  );
  assert.equal(result.state, 'unknown');
  assert.equal(result.ignoredDifferentPropositionsOrScopes, 5);
});

test('repeated supporting sources do not erase a distinct contradiction or inflate source diversity', () => {
  const result = evaluateEvidence(query, [
    assertion('a', 'positive', query, 'same-source'),
    assertion('b', 'positive', query, 'same-source'),
    assertion('c', 'negative'),
  ]);
  assert.equal(result.state, 'both');
  assert.equal(result.supporting.length, 2);
  assert.equal(result.distinctSupportingSources.length, 1);
});

test('duplicate assertion identifiers are rejected rather than double counted', () => {
  assert.throws(
    () => evaluateEvidence(query, [assertion('a', 'positive'), assertion('a', 'negative')]),
    /unique/,
  );
});

const contextItems = [
  { id: 'scope', text: 'Project staging only.', requires: [], kind: 'scope' },
  { id: 'negative', text: 'Do not restart production.', requires: ['scope'], kind: 'negation' },
  { id: 'source', text: 'Staging check failed.', requires: ['scope'], kind: 'evidence' },
  {
    id: 'claim',
    text: 'The staging service needs investigation.',
    requires: ['negative', 'source'],
    kind: 'claim',
  },
  { id: 'extra', text: 'Unselected unrelated material.', requires: [] },
];

test('context selection preserves authored negation, scope and source dependencies exactly', () => {
  const result = selectContext(contextItems, ['claim'], 100);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.requiredIds, ['scope', 'negative', 'source', 'claim']);
  assert.ok(result.payload.includes('Do not restart production.'));
  assert.ok(result.payload.includes('Project staging only.'));
  assert.equal(result.requiredUnits, wordUnits(result.payload));
  assert.equal(result.payload.includes('Unselected'), false);
});

test('context overflow returns no partial payload or truncated claim', () => {
  const result = selectContext(contextItems, ['claim'], 4);
  assert.equal(result.status, 'budget_overflow');
  assert.equal(result.payload, null);
  assert.deepEqual(result.items, []);
  assert.ok(result.requiredUnits > result.budget);
});

test('missing context dependencies block delivery even when the visible text fits', () => {
  const result = selectContext(
    [{ id: 'claim', text: 'Approved.', requires: ['missing-source'] }],
    ['claim'],
    100,
  );
  assert.equal(result.status, 'missing_dependency');
  assert.deepEqual(result.missingIds, ['missing-source']);
  assert.equal(result.payload, null);
});

test('cyclic context dependencies terminate and preserve both items once', () => {
  const result = selectContext(
    [
      { id: 'a', text: 'A depends on B.', requires: ['b'] },
      { id: 'b', text: 'B depends on A.', requires: ['a'] },
    ],
    ['a'],
    100,
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.cycles, [['a', 'b', 'a']]);
  assert.equal(new Set(result.requiredIds).size, 2);
});

test('context exact boundary, empty selection and multilingual word-unit caveat are explicit', () => {
  const required = selectContext(contextItems, ['claim'], 100).requiredUnits;
  assert.equal(selectContext(contextItems, ['claim'], required).status, 'ready');
  assert.equal(selectContext(contextItems, ['claim'], required - 1).status, 'budget_overflow');
  assert.equal(selectContext(contextItems, [], 0).payload, '');
  assert.equal(wordUnits('  one\n two\tthree '), 3);
  assert.equal(wordUnits('没有空格'), 1); // This is intentionally not a tokenizer.
});

test('planning, simulation and copied presets do not mutate inputs', () => {
  const problem = createPreset('hosting');
  const before = JSON.stringify(problem);
  executePlan(problem, plan(problem).actionIds, { outcomes: { repair: 'failure' } });
  assert.equal(JSON.stringify(problem), before);
  problem.initial.issue_reported = false;
  assert.equal(createPreset('hosting').initial.issue_reported, true);
});
