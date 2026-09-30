import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import {
  LearningReleaseError,
  datasetHash,
  datasetVersion,
  planDatasetVersion,
  splitHoldout,
  verifyHoldoutDisjoint,
  assertReleaseConsent,
  CANARY_STAGES,
  nextCanaryStage,
  startCanaryStage,
  checkCanaryGate,
  recordCanaryOutcome,
  planRollback,
  createReleaseStore,
} from '../lib/learning/releases.ts';
import {
  weightProvenance,
  formatWeights,
  metricsReport,
  checkNoRegression,
} from '../lib/learning/metrics.ts';

const items = (n, prefix = 'fp') =>
  Array.from({ length: n }, (_, i) => ({ fingerprint: `${prefix}-${i}` }));
const langMetric = (language, accuracy, sampleCount = 50) => ({
  language,
  accuracy,
  secondary: {},
  sampleCount,
});
const named = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LearningReleaseError, 'refusals are named LearningReleaseError');
    return error.code;
  }
  assert.fail('expected a named refusal');
};

function setup(t) {
  const db = applySchema(new DatabaseSync(':memory:'));
  db.exec('PRAGMA foreign_keys=ON');
  const store = createReleaseStore(db, () => '2026-09-30T07:00:00.000Z');
  t.after(() => db.close());
  return { db, store };
}

/* ---- dataset versioning: a change without a bump is refused ---- */

test('datasetHash is deterministic regardless of item order', () => {
  assert.equal(datasetHash(items(10)), datasetHash([...items(10)].reverse()));
});

test('datasetHash changes when any item changes', () => {
  const a = items(10);
  const b = items(10);
  b[3] = { fingerprint: 'fp-changed' };
  assert.notEqual(datasetHash(a), datasetHash(b));
});

test('datasetVersion derives from the hash', () => {
  const hash = datasetHash(items(5));
  assert.equal(datasetVersion(hash), 'ds-' + hash.slice(0, 12));
});

test('planDatasetVersion accepts the content-derived version for new content', () => {
  const plan = planDatasetVersion({ items: items(8) });
  assert.equal(plan.version, datasetVersion(plan.hash));
  assert.equal(plan.reused, false);
});

test('planDatasetVersion refuses changed content under the old version id', () => {
  const oldItems = items(8);
  const oldVersion = planDatasetVersion({ items: oldItems }).version;
  const changed = items(8);
  changed[0] = { fingerprint: 'fp-new' };
  // The old id already means the old content: keeping the name while the
  // bytes changed is refused.
  const code = named(() =>
    planDatasetVersion({
      items: changed,
      claimedVersion: oldVersion,
      known: new Map([[oldVersion, datasetHash(oldItems)]]),
    }),
  );
  assert.equal(code, 'version-conflict');
});

test('planDatasetVersion refuses an arbitrary new id instead of the content-derived bump', () => {
  const code = named(() =>
    planDatasetVersion({ items: items(8), claimedVersion: 'ds-my-custom-v2' }),
  );
  assert.equal(code, 'version-bump-required');
});

test('planDatasetVersion refuses a version id that already means different content, and reuses identical content', () => {
  const a = items(6);
  const b = items(6, 'other');
  const versionA = planDatasetVersion({ items: a }).version;
  const known = new Map([[versionA, datasetHash(a)]]);
  assert.equal(
    named(() => planDatasetVersion({ items: b, claimedVersion: versionA, known })),
    'version-conflict',
  );
  const reuse = planDatasetVersion({ items: a, known });
  assert.equal(reuse.version, versionA);
  assert.equal(reuse.reused, true);
});

/* ---- independent holdout: deterministic by seed, disjoint, never trained on ---- */

test('splitHoldout is deterministic by seed', () => {
  const first = splitHoldout(items(20), { seed: 'seed-1' });
  const second = splitHoldout(items(20), { seed: 'seed-1' });
  assert.deepEqual(
    first.holdout.map((i) => i.fingerprint),
    second.holdout.map((i) => i.fingerprint),
  );
});

test('splitHoldout train and holdout are disjoint and cover every item', () => {
  const { train, holdout } = splitHoldout(items(20), { seed: 'seed-1' });
  assert.doesNotThrow(() => verifyHoldoutDisjoint(train, holdout));
  assert.equal(train.length + holdout.length, 20);
  assert.equal(holdout.length, 4); // ceil(20 * 0.2)
  assert.ok(train.length > 0 && holdout.length > 0);
});

test('verifyHoldoutDisjoint throws a named error on overlap', () => {
  const train = items(10);
  const holdout = [{ fingerprint: 'fp-3' }, { fingerprint: 'fp-99' }];
  assert.equal(
    named(() => verifyHoldoutDisjoint(train, holdout)),
    'holdout-overlap',
  );
});

test('splitHoldout never leaves the holdout empty', () => {
  const { holdout } = splitHoldout(items(3), { seed: 's', holdoutPct: 0.2 });
  assert.equal(holdout.length, 1);
});

test('holdout items are always a subset of the dataset', () => {
  const all = items(15);
  const { holdout } = splitHoldout(all, { seed: 's' });
  const known = new Set(all.map((i) => i.fingerprint));
  for (const item of holdout) assert.ok(known.has(item.fingerprint));
});

test('store.recordHoldout round-trips and is idempotent per dataset+seed', (t) => {
  const { store } = setup(t);
  const plan = planDatasetVersion({ items: items(10) });
  store.recordDataset({
    version: plan.version,
    language: 'en',
    source: 'owner-reviewed',
    consentScope: 'learning',
    consentRevision: 1,
    hash: plan.hash,
    itemCount: 10,
  });
  const split = splitHoldout(items(10), { seed: 'seed-1' });
  const id = store.recordHoldout({
    datasetVersion: plan.version,
    splitSeed: 'seed-1',
    items: split.holdout.map((i) => i.fingerprint),
  });
  assert.equal(
    store.recordHoldout({
      datasetVersion: plan.version,
      splitSeed: 'seed-1',
      items: split.holdout.map((i) => i.fingerprint),
    }),
    id,
  );
  assert.deepEqual(
    store.holdoutBy(plan.version, 'seed-1'),
    split.holdout.map((i) => i.fingerprint),
  );
});

/* ---- consent gate: hard-refuse (JEV 2026-09-30) ---- */

test('assertReleaseConsent passes when learning is enabled at the current revision', () => {
  assert.doesNotThrow(() =>
    assertReleaseConsent({ policy: { enabled: true, revision: 3 }, consentRevision: 3 }),
  );
});

test('assertReleaseConsent refuses when learning consent is disabled', () => {
  const error = (() => {
    try {
      assertReleaseConsent({ policy: { enabled: false, revision: 3 }, consentRevision: 3 });
    } catch (e) {
      return e;
    }
    assert.fail('expected refusal');
  })();
  assert.ok(error instanceof LearningReleaseError);
  assert.equal(error.code, 'consent-required');
  assert.equal(error.status, 403);
});

test('assertReleaseConsent refuses data captured under a different revision (hard-refuse)', () => {
  assert.equal(
    named(() =>
      assertReleaseConsent({ policy: { enabled: true, revision: 4 }, consentRevision: 3 }),
    ),
    'consent-required',
  );
});

test('assertReleaseConsent refuses a dataset needing a newer revision than current', () => {
  assert.equal(
    named(() =>
      assertReleaseConsent({ policy: { enabled: true, revision: 2 }, consentRevision: 5 }),
    ),
    'consent-required',
  );
});

/* ---- canary policy: 5% → 25% → 100%, inspect-then-decide (JEV 2026-09-30) ---- */

test('CANARY_STAGES runs 5% → 25% → 100%', () => {
  assert.deepEqual(
    CANARY_STAGES.map((s) => [s.stage, s.cohortPct]),
    [
      ['canary-5pct', 5],
      ['canary-25pct', 25],
      ['canary-100pct', 100],
    ],
  );
});

test('nextCanaryStage starts at canary-5pct and advances in order', () => {
  assert.deepEqual(nextCanaryStage({ passed: [], blocked: [] }), {
    stage: 'canary-5pct',
    retry: false,
  });
  assert.deepEqual(nextCanaryStage({ passed: ['canary-5pct'], blocked: [] }), {
    stage: 'canary-25pct',
    retry: false,
  });
  assert.equal(
    nextCanaryStage({ passed: ['canary-5pct', 'canary-25pct', 'canary-100pct'], blocked: [] }),
    null,
  );
});

test('a blocked stage is retried, never skipped', () => {
  assert.deepEqual(nextCanaryStage({ passed: ['canary-5pct'], blocked: ['canary-25pct'] }), {
    stage: 'canary-25pct',
    retry: true,
  });
});

test('startCanaryStage refuses skipping a stage', () => {
  assert.equal(
    named(() => startCanaryStage({ stage: 'canary-25pct', passed: [], blocked: [] })),
    'canary-stage-order',
  );
});

test('startCanaryStage refuses starting after full rollout', () => {
  assert.equal(
    named(() =>
      startCanaryStage({
        stage: 'canary-5pct',
        passed: ['canary-5pct', 'canary-25pct', 'canary-100pct'],
        blocked: [],
      }),
    ),
    'canary-stage-order',
  );
});

test('checkCanaryGate passes when no language regresses beyond epsilon', () => {
  const gate = checkCanaryGate({
    baseline: { en: langMetric('en', 0.9), ar: langMetric('ar', 0.85) },
    candidate: { en: langMetric('en', 0.91), ar: langMetric('ar', 0.848) },
  });
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.failures, []);
});

test('checkCanaryGate fails naming the regressing language', () => {
  const gate = checkCanaryGate({
    baseline: { en: langMetric('en', 0.9), ar: langMetric('ar', 0.85) },
    candidate: { en: langMetric('en', 0.92), ar: langMetric('ar', 0.8) },
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.failures.length, 1);
  assert.equal(gate.failures[0].language, 'ar');
});

test('checkCanaryGate with no baseline passes vacuously but records the note', () => {
  const gate = checkCanaryGate({
    baseline: null,
    candidate: { en: langMetric('en', 0.9) },
  });
  assert.equal(gate.passed, true);
  assert.match(gate.note, /no-baseline/);
});

test('recordCanaryOutcome maps gate results to passed/blocked', () => {
  assert.equal(recordCanaryOutcome({ gatePassed: true }), 'passed');
  assert.equal(recordCanaryOutcome({ gatePassed: false }), 'blocked');
});

test('store canary flow: approve → 5pct → 25pct → 100pct → live, previous superseded', (t) => {
  const { store } = setup(t);
  const plan = planDatasetVersion({ items: items(10) });
  store.recordDataset({
    version: plan.version,
    language: 'en',
    source: 'owner-reviewed',
    consentScope: 'learning',
    consentRevision: 1,
    hash: plan.hash,
    itemCount: 10,
  });
  const first = store.createRelease({
    datasetVersion: plan.version,
    previousReleaseId: null,
    createdBy: 'owner',
  });
  store.recordApproval({
    releaseId: first,
    approver: 'owner',
    decision: 'approved',
    reason: 'gates green',
  });
  store.setStatus(first, 'approved', ['proposed']);
  store.setStatus(first, 'canarying', ['approved']);
  for (const stage of ['canary-5pct', 'canary-25pct', 'canary-100pct']) {
    const canaryId = store.startCanary({ releaseId: first, stage, cohortPct: 5 });
    store.completeCanary({ canaryId, outcome: 'passed', metricsJson: '{"perLanguage":{}}' });
  }
  assert.equal(store.release(first).status, 'live');

  // A second release supersedes the first when it goes live.
  const plan2 = planDatasetVersion({ items: items(10, 'v2') });
  store.recordDataset({
    version: plan2.version,
    language: 'en',
    source: 'owner-reviewed',
    consentScope: 'learning',
    consentRevision: 1,
    hash: plan2.hash,
    itemCount: 10,
  });
  const second = store.createRelease({
    datasetVersion: plan2.version,
    previousReleaseId: first,
    createdBy: 'owner',
  });
  store.setStatus(second, 'approved', ['proposed']);
  store.setStatus(second, 'canarying', ['approved']);
  for (const stage of ['canary-5pct', 'canary-25pct', 'canary-100pct']) {
    const canaryId = store.startCanary({ releaseId: second, stage, cohortPct: 5 });
    store.completeCanary({ canaryId, outcome: 'passed', metricsJson: '{"perLanguage":{}}' });
  }
  assert.equal(store.release(second).status, 'live');
  assert.equal(store.release(first).status, 'superseded');
  assert.equal(store.activeRelease()?.id, second);
});

/* ---- rollback: first-class, deactivates, never deletes ---- */

test('planRollback picks the live release and the version it superseded', () => {
  const plan = planRollback([
    {
      id: 'rel-old',
      datasetVersion: 'ds-1',
      status: 'superseded',
      previousReleaseId: null,
      createdAt: '2026-09-29T00:00:00.000Z',
    },
    {
      id: 'rel-new',
      datasetVersion: 'ds-2',
      status: 'live',
      previousReleaseId: 'rel-old',
      createdAt: '2026-09-30T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(plan, { deactivateId: 'rel-new', activateId: 'rel-old' });
});

test('planRollback throws nothing-to-rollback when nothing is live', () => {
  assert.equal(
    named(() =>
      planRollback([
        {
          id: 'rel-a',
          datasetVersion: 'ds-1',
          status: 'rolled-back',
          previousReleaseId: null,
          createdAt: '2026-09-29T00:00:00.000Z',
        },
      ]),
    ),
    'nothing-to-rollback',
  );
});

test('store.rollback deactivates the release and reactivates the previous version', (t) => {
  const { db, store } = setup(t);
  const mk = (prefix) => {
    const plan = planDatasetVersion({ items: items(10, prefix) });
    store.recordDataset({
      version: plan.version,
      language: 'en',
      source: 'owner-reviewed',
      consentScope: 'learning',
      consentRevision: 1,
      hash: plan.hash,
      itemCount: 10,
    });
    return plan.version;
  };
  const v1 = mk('v1');
  const v2 = mk('v2');
  const first = store.createRelease({
    datasetVersion: v1,
    previousReleaseId: null,
    createdBy: 'owner',
  });
  store.setStatus(first, 'approved', ['proposed']);
  store.setStatus(first, 'live', ['approved']);
  const second = store.createRelease({
    datasetVersion: v2,
    previousReleaseId: first,
    createdBy: 'owner',
  });
  store.setStatus(second, 'approved', ['proposed']);
  store.setStatus(second, 'live', ['approved']);
  store.setStatus(first, 'superseded', ['live']);

  const before = {
    datasets: db.prepare('SELECT COUNT(*) n FROM learning_datasets').get().n,
    holdouts: db.prepare('SELECT COUNT(*) n FROM learning_holdout_sets').get().n,
    canaries: db.prepare('SELECT COUNT(*) n FROM learning_release_canaries').get().n,
    approvals: db.prepare('SELECT COUNT(*) n FROM learning_release_approvals').get().n,
    releases: db.prepare('SELECT COUNT(*) n FROM learning_releases').get().n,
  };
  const result = store.rollback({
    releaseId: second,
    approver: 'owner',
    reason: 'regression in ar',
  });
  assert.deepEqual(result, { deactivated: second, reactivated: first });
  assert.equal(store.release(second).status, 'rolled-back');
  assert.equal(store.release(first).status, 'live');
  // Nothing is deleted: every row survives the rollback (approvals gain the rollback record).
  const after = {
    datasets: db.prepare('SELECT COUNT(*) n FROM learning_datasets').get().n,
    holdouts: db.prepare('SELECT COUNT(*) n FROM learning_holdout_sets').get().n,
    canaries: db.prepare('SELECT COUNT(*) n FROM learning_release_canaries').get().n,
    approvals: db.prepare('SELECT COUNT(*) n FROM learning_release_approvals').get().n,
    releases: db.prepare('SELECT COUNT(*) n FROM learning_releases').get().n,
  };
  assert.deepEqual(after, { ...before, approvals: before.approvals + 1 });
  const decisions = db
    .prepare('SELECT decision FROM learning_release_approvals WHERE release_id=?')
    .all(second)
    .map((r) => r.decision);
  assert.ok(decisions.includes('rollback'));
});

test('store.rollback throws nothing-to-rollback for a first release', (t) => {
  const { store } = setup(t);
  const plan = planDatasetVersion({ items: items(10) });
  store.recordDataset({
    version: plan.version,
    language: 'en',
    source: 'owner-reviewed',
    consentScope: 'learning',
    consentRevision: 1,
    hash: plan.hash,
    itemCount: 10,
  });
  const first = store.createRelease({
    datasetVersion: plan.version,
    previousReleaseId: null,
    createdBy: 'owner',
  });
  store.setStatus(first, 'live', ['proposed']);
  assert.equal(
    named(() => store.rollback({ releaseId: first, approver: 'owner', reason: 'x' })),
    'nothing-to-rollback',
  );
});

test('store.rollback refuses a release that is not live or canarying', (t) => {
  const { store } = setup(t);
  const plan = planDatasetVersion({ items: items(10) });
  store.recordDataset({
    version: plan.version,
    language: 'en',
    source: 'owner-reviewed',
    consentScope: 'learning',
    consentRevision: 1,
    hash: plan.hash,
    itemCount: 10,
  });
  const id = store.createRelease({
    datasetVersion: plan.version,
    previousReleaseId: null,
    createdBy: 'owner',
  });
  assert.equal(
    named(() => store.rollback({ releaseId: id, approver: 'owner', reason: 'x' })),
    'invalid-release-state',
  );
});

test('latestLive returns the newest live release other than the canarying one', (t) => {
  const { store } = setup(t);
  const mk = (prefix) => {
    const plan = planDatasetVersion({ items: items(10, prefix) });
    store.recordDataset({
      version: plan.version,
      language: 'en',
      source: 'owner-reviewed',
      consentScope: 'learning',
      consentRevision: 1,
      hash: plan.hash,
      itemCount: 10,
    });
    return plan.version;
  };
  const v1 = mk('v1');
  const v2 = mk('v2');
  const first = store.createRelease({
    datasetVersion: v1,
    previousReleaseId: null,
    createdBy: 'owner',
  });
  store.setStatus(first, 'live', ['proposed']);
  const second = store.createRelease({
    datasetVersion: v2,
    previousReleaseId: first,
    createdBy: 'owner',
  });
  store.setStatus(second, 'canarying', ['proposed']);
  // The canary gate baseline is "what production runs today": the live
  // release, not the canarying one.
  assert.equal(store.latestLive(second)?.id, first);
  assert.equal(store.latestLive()?.id, first);
  assert.equal(store.latestLive(first)?.id, undefined);
});

/* ---- per-language metrics: never a blended score ---- */

test('metricsReport lists each language separately with its own numbers', () => {
  const report = metricsReport({
    metrics: [langMetric('en', 0.91), langMetric('ar', 0.84, 30)],
    weights: { provider: 'fixture' },
    provenance: weightProvenance({
      provider: 'fixture-provider',
      evaluatedAt: '2026-09-30T07:00:00.000Z',
      holdoutId: 'ho-1',
    }),
  });
  assert.deepEqual(report.languages, ['ar', 'en']);
  assert.equal(report.perLanguage.en.accuracy, 0.91);
  assert.equal(report.perLanguage.ar.sampleCount, 30);
});

test('metricsReport carries no blended, average or overall score', () => {
  const report = metricsReport({
    metrics: [langMetric('en', 0.5), langMetric('ar', 1.0)],
    weights: {},
    provenance: weightProvenance({ provider: 'p', evaluatedAt: 't', holdoutId: 'h' }),
  });
  const json = JSON.stringify(report).toLowerCase();
  for (const word of ['blended', 'average', 'overall', 'mean', 'combined'])
    assert.ok(!json.includes(`"${word}"`), `report must not contain a ${word} field`);
});

test('checkNoRegression names every regressing language', () => {
  const { ok, failures } = checkNoRegression(
    { en: langMetric('en', 0.9), ar: langMetric('ar', 0.85), hi: langMetric('hi', 0.8) },
    { en: langMetric('en', 0.905), ar: langMetric('ar', 0.7), hi: langMetric('hi', 0.78) },
  );
  assert.equal(ok, false);
  assert.deepEqual(
    failures.map((f) => f.language),
    ['ar', 'hi'],
  );
});

test('metricsReport refuses empty metrics', () => {
  assert.equal(
    named(() =>
      metricsReport({
        metrics: [],
        weights: {},
        provenance: weightProvenance({ provider: 'p', evaluatedAt: 't', holdoutId: 'h' }),
      }),
    ),
    'metrics-empty',
  );
});

test('metricsReport refuses unlabeled weights', () => {
  assert.equal(
    named(() => metricsReport({ metrics: [langMetric('en', 0.9)], weights: {} })),
    'weights-unlabeled',
  );
});

/* ---- provider weights honesty: unlabeled weights are refused ---- */

test('weightProvenance labels source, timestamp and holdout', () => {
  const label = weightProvenance({
    provider: 'provider.test',
    evaluatedAt: '2026-09-30T07:00:00.000Z',
    holdoutId: 'ho-abc',
  });
  assert.equal(
    label,
    'weights from provider.test, evaluated 2026-09-30T07:00:00.000Z on holdout ho-abc',
  );
});

test('formatWeights throws weights-unlabeled when provenance is missing', () => {
  assert.equal(
    named(() => formatWeights({ weights: { a: 1 } })),
    'weights-unlabeled',
  );
  assert.equal(
    named(() => formatWeights({ weights: { a: 1 }, provenance: '' })),
    'weights-unlabeled',
  );
  assert.equal(
    named(() => formatWeights({ weights: { a: 1 }, provenance: null })),
    'weights-unlabeled',
  );
});

test('formatWeights throws weights-unlabeled on a malformed label', () => {
  assert.equal(
    named(() => formatWeights({ weights: { a: 1 }, provenance: 'evaluated yesterday' })),
    'weights-unlabeled',
  );
  assert.equal(
    named(() => formatWeights({ weights: { a: 1 }, provenance: 'weights from p, evaluated t' })),
    'weights-unlabeled',
  );
});

test('formatWeights accepts a proper provenance label', () => {
  const label = weightProvenance({ provider: 'p', evaluatedAt: 't', holdoutId: 'h' });
  const out = formatWeights({ weights: { a: 1 }, provenance: label });
  assert.equal(out.label, label);
  assert.deepEqual(out.weights, { a: 1 });
});
