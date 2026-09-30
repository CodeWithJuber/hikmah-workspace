/** Learning release controls: versioned datasets, independent holdouts,
 * staged canaries, approvals, and first-class rollback.
 *
 * This module wraps the existing learning pipeline (lib/learning/) with
 * release discipline; it does not rebuild the pipeline. The rules:
 *
 * - Dataset versioning: the version id is derived from the sha256 of the
 *   canonical dataset content. Proposing changed content under the old
 *   version id is refused (version-bump-required); recording a version id
 *   that already means different content is refused (version-conflict).
 * - Independent holdout: the train/holdout split is deterministic by seed,
 *   disjoint by construction and verified by test. Holdout items are never
 *   trained on.
 * - Consent gate (JEV hard-refuse, 2026-09-30): a release requires the
 *   CURRENT consent policy — enabled, and revision equal to the dataset's
 *   consent revision. Revoked or reconfigured consent refuses the release
 *   with a named error. No silent inclusion.
 * - Canary policy (JEV inspect-then-decide, 2026-09-30): 5% → 25% → 100%
 *   stages with per-language no-regression gates. Stages cannot be skipped;
 *   a failed gate BLOCKS advancement and the owner then retries the stage
 *   or rolls back — the canary never auto-advances past a failure.
 * - Rollback is a first-class operation: it deactivates the release and
 *   reactivates the previous one. It never deletes datasets, holdouts,
 *   canary records or metrics.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteHandle } from '../runs/store.ts';
import { checkNoRegression, type LanguageMetrics } from './metrics.ts';

/** Named release errors: every refusal carries a code the tests and the
 * routes can assert on, never a bare message. */
export class LearningReleaseError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'LearningReleaseError';
    this.code = code;
    this.status = status;
  }
}

export type DatasetItem = { fingerprint: string; text?: string };

/** sha256 over the canonical content: fingerprints sorted, then JSON. The
 * same content always hashes the same; any content change changes the hash. */
export function datasetHash(items: readonly DatasetItem[]): string {
  const canonical = JSON.stringify(
    [...items]
      .map((item) => item.fingerprint)
      .sort()
      .map((fingerprint) => ({ fingerprint })),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** The version id IS the content hash (truncated for readability). There is
 * no way to change content under the same id — the id moves with the bytes. */
export function datasetVersion(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new LearningReleaseError(
      'version-invalid',
      'A dataset version needs a full sha256 hash.',
      422,
    );
  return 'ds-' + hash.slice(0, 12);
}

export type DatasetPlan = { version: string; hash: string; reused: boolean };

/** Plan the version for a dataset proposal. known maps version → hash for
 * every recorded dataset.
 *
 * - Same content as a recorded dataset → reuse its version (no duplicate).
 * - New content with no claimed version → the content-derived version.
 * - New content claiming a fresh id that is not the content-derived one →
 *   version-bump-required (a change without a bump is refused).
 * - Claiming an id that already means different content → version-conflict. */
export function planDatasetVersion(input: {
  items: readonly DatasetItem[];
  claimedVersion?: string;
  known?: ReadonlyMap<string, string>;
}): DatasetPlan {
  if (!input.items.length)
    throw new LearningReleaseError(
      'dataset-empty',
      'A release dataset needs at least one item.',
      422,
    );
  const hash = datasetHash(input.items);
  const expected = datasetVersion(hash);
  const known = input.known ?? new Map<string, string>();
  const claimed = input.claimedVersion;
  if (claimed !== undefined) {
    const knownHash = known.get(claimed);
    if (knownHash !== undefined && knownHash !== hash)
      throw new LearningReleaseError(
        'version-conflict',
        `Version ${claimed} already records different content. Bump to ${expected} for the new content.`,
        409,
      );
    if (knownHash === hash) return { version: claimed, hash, reused: true };
    if (claimed !== expected)
      throw new LearningReleaseError(
        'version-bump-required',
        `The dataset changed but the version was not bumped: content hashes to ${expected}, not ${claimed}.`,
        409,
      );
    return { version: claimed, hash, reused: false };
  }
  for (const [version, knownHash] of known)
    if (knownHash === hash) return { version, hash, reused: true };
  return { version: expected, hash, reused: false };
}

export type HoldoutSplit = { train: DatasetItem[]; holdout: DatasetItem[] };

/** Deterministic train/holdout split by seed: items are ranked by
 * sha256(seed:fingerprint) and the first holdoutCount become the holdout.
 * Same seed + same items → the same split, always disjoint, never empty. */
export function splitHoldout(
  items: readonly DatasetItem[],
  input: { seed: string; holdoutPct?: number },
): HoldoutSplit {
  const seed = input.seed;
  if (!seed.trim())
    throw new LearningReleaseError('holdout-no-seed', 'A holdout split needs a seed.', 422);
  const pct = input.holdoutPct ?? 0.2;
  if (!(pct > 0 && pct < 1))
    throw new LearningReleaseError(
      'holdout-bad-pct',
      'The holdout fraction must be between 0 and 1 (exclusive).',
      422,
    );
  const ranked = [...items].sort((a, b) => {
    const ha = createHash('sha256')
      .update(seed + ':' + a.fingerprint)
      .digest('hex');
    const hb = createHash('sha256')
      .update(seed + ':' + b.fingerprint)
      .digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const holdoutCount = Math.max(1, Math.ceil(ranked.length * pct));
  const holdout = ranked.slice(0, holdoutCount);
  const holdoutSet = new Set(holdout.map((item) => item.fingerprint));
  return {
    holdout,
    train: ranked.filter((item) => !holdoutSet.has(item.fingerprint)),
  };
}

/** The independence proof: any fingerprint in both sets is a hard failure.
 * Holdout items must never be trained on. */
export function verifyHoldoutDisjoint(
  train: readonly DatasetItem[],
  holdout: readonly DatasetItem[],
): void {
  const trainSet = new Set(train.map((item) => item.fingerprint));
  for (const item of holdout)
    if (trainSet.has(item.fingerprint))
      throw new LearningReleaseError(
        'holdout-overlap',
        `Holdout item ${item.fingerprint} also appears in the training set — the holdout is not independent.`,
        500,
      );
}

export type ConsentPolicy = { enabled: boolean; revision: number };

/** The release consent gate (JEV hard-refuse): the CURRENT consent policy
 * must cover the dataset. Disabled learning refuses everything; a dataset
 * captured under a different consent revision is refused — revoked or
 * reconfigured consent never rides an old dataset into production. */
export function assertReleaseConsent(input: {
  policy: ConsentPolicy;
  consentRevision: number;
}): void {
  if (!input.policy.enabled)
    throw new LearningReleaseError(
      'consent-required',
      'Learning consent is not enabled. Enable learning before proposing a release — data captured without consent is never released.',
      403,
    );
  if (input.policy.revision !== input.consentRevision)
    throw new LearningReleaseError(
      'consent-required',
      `The dataset was captured under consent revision ${input.consentRevision} but the current revision is ${input.policy.revision}. Re-capture under current consent; releases never ride revoked or reconfigured consent.`,
      403,
    );
}

export const CANARY_STAGES = [
  { stage: 'canary-5pct', cohortPct: 5 },
  { stage: 'canary-25pct', cohortPct: 25 },
  { stage: 'canary-100pct', cohortPct: 100 },
] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number]['stage'];

/** The next stage to run: the first stage that is neither passed nor blocked
 * (a blocked stage is retried, per inspect-then-decide). null when every
 * stage passed. */
export function nextCanaryStage(input: {
  passed: readonly string[];
  blocked: readonly string[];
}): { stage: CanaryStage; retry: boolean } | null {
  const passed = new Set(input.passed);
  const blocked = new Set(input.blocked);
  for (const { stage } of CANARY_STAGES) {
    if (blocked.has(stage)) return { stage, retry: true };
    if (!passed.has(stage)) return { stage, retry: false };
  }
  return null;
}

/** Start a canary stage: the requested stage must be exactly the next one —
 * stages cannot be skipped. */
export function startCanaryStage(input: {
  stage: string;
  passed: readonly string[];
  blocked: readonly string[];
}): CanaryStage {
  const next = nextCanaryStage(input);
  if (!next)
    throw new LearningReleaseError(
      'canary-stage-order',
      'Every canary stage already passed — this release is fully rolled out.',
      409,
    );
  if (input.stage !== next.stage)
    throw new LearningReleaseError(
      'canary-stage-order',
      `Canary stages run in order (5% → 25% → 100%); ${next.stage} is next, not ${input.stage}.`,
      409,
    );
  return next.stage;
}

export type CanaryGate = {
  passed: boolean;
  failures: { language: string; baseline: number; candidate: number }[];
  note: string;
};

/** A canary stage's metric gate: every language in the baseline must stay
 * within maxRegression of its holdout accuracy. A null baseline (first
 * release) passes vacuously — the per-language report still has to exist
 * and be provenance-labeled. */
export function checkCanaryGate(input: {
  baseline: Readonly<Record<string, LanguageMetrics>> | null;
  candidate: Readonly<Record<string, LanguageMetrics>>;
  maxRegression?: number;
}): CanaryGate {
  if (!input.baseline)
    return { passed: true, failures: [], note: 'no-baseline: first release, report recorded' };
  const { ok, failures } = checkNoRegression(input.baseline, input.candidate, input.maxRegression);
  return {
    passed: ok,
    failures,
    note: ok ? 'no language regressed beyond the gate' : `${failures.length} language(s) regressed`,
  };
}

/** Record a stage outcome: passed advances the canary; blocked freezes it —
 * the owner then retries the stage or rolls back (inspect-then-decide).
 * The canary never auto-advances past a failed gate. */
export function recordCanaryOutcome(input: { gatePassed: boolean }): 'passed' | 'blocked' {
  return input.gatePassed ? 'passed' : 'blocked';
}

export type ReleaseSummary = {
  id: string;
  datasetVersion: string;
  status: string;
  previousReleaseId: string | null;
  createdAt: string;
};
export type ReleaseCanaryRow = {
  id: string;
  release_id: string;
  stage: string;
  cohort_pct: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  metrics_json: string;
};
export type ReleaseApprovalRow = {
  id: string;
  release_id: string;
  approver: string;
  decision: string;
  reason: string;
  created_at: string;
};

/** Plan a rollback: deactivate the live/canarying release, reactivate the
 * release it superseded. Rows are updated, never deleted — datasets,
 * holdouts, canary records and metrics all survive the rollback. */
export function planRollback(releases: readonly ReleaseSummary[]): {
  deactivateId: string;
  activateId: string;
} {
  const active = [...releases]
    .filter((r) => r.status === 'live' || r.status === 'canarying')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!active)
    throw new LearningReleaseError(
      'nothing-to-rollback',
      'There is no live or canarying release to roll back.',
      409,
    );
  const previous = active.previousReleaseId
    ? releases.find((r) => r.id === active.previousReleaseId)
    : undefined;
  if (!previous)
    throw new LearningReleaseError(
      'nothing-to-rollback',
      'This release supersedes nothing — there is no previous version to restore.',
      409,
    );
  return { deactivateId: active.id, activateId: previous.id };
}

export type ReleaseStore = ReturnType<typeof createReleaseStore>;

/** Durable release ledger on node:sqlite. Status transitions are guarded;
 * rollback deactivates, never deletes. */
export function createReleaseStore(db: SqliteHandle, now = () => new Date().toISOString()) {
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const releaseRow = (id: string) => {
    const row = db
      .prepare(
        `SELECT id, dataset_version AS datasetVersion, status,
                previous_release_id AS previousReleaseId, created_at AS createdAt
         FROM learning_releases WHERE id=?`,
      )
      .get(id) as ReleaseSummary | undefined;
    if (!row)
      throw new LearningReleaseError('unknown-release', `Release ${id} does not exist.`, 404);
    return row;
  };
  const setStatus = (id: string, status: string, expected: readonly string[]) => {
    const row = releaseRow(id);
    if (!expected.includes(row.status))
      throw new LearningReleaseError(
        'invalid-release-state',
        `Release ${id} is ${row.status}; expected ${expected.join(' or ')} for this transition.`,
        409,
      );
    db.prepare('UPDATE learning_releases SET status=?, updated_at=? WHERE id=?').run(
      status,
      now(),
      id,
    );
  };
  const recordApproval = (input: {
    releaseId: string;
    approver: string;
    decision: string;
    reason: string;
  }) => {
    releaseRow(input.releaseId);
    if (!input.reason.trim())
      throw new LearningReleaseError(
        'approval-no-reason',
        'An approval decision needs a reason — silent approvals are not recorded.',
        422,
      );
    const id = 'appr-' + randomUUID();
    db.prepare(
      `INSERT INTO learning_release_approvals (id, release_id, approver, decision, reason, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, input.releaseId, input.approver, input.decision, input.reason.trim(), now());
    return id;
  };
  return {
    recordDataset(input: {
      version: string;
      language: string;
      source: string;
      consentScope: string;
      consentRevision: number;
      hash: string;
      itemCount: number;
    }) {
      const existing = db
        .prepare('SELECT version, hash FROM learning_datasets WHERE version=?')
        .get(input.version) as { version: string; hash: string } | undefined;
      if (existing && existing.hash !== input.hash)
        throw new LearningReleaseError(
          'version-conflict',
          `Version ${input.version} already records different content.`,
          409,
        );
      if (existing) return existing.version;
      const id = 'dsrow-' + randomUUID();
      db.prepare(
        `INSERT INTO learning_datasets
         (id, version, language, source, consent_scope, consent_revision, hash, item_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        input.version,
        input.language,
        input.source,
        input.consentScope,
        input.consentRevision,
        input.hash,
        input.itemCount,
        now(),
      );
      return input.version;
    },
    listDatasets() {
      return db
        .prepare('SELECT version, hash, language, consent_revision FROM learning_datasets')
        .all() as { version: string; hash: string; language: string; consent_revision: number }[];
    },
    datasetByVersion(version: string) {
      return db.prepare('SELECT * FROM learning_datasets WHERE version=?').get(version) as
        | {
            version: string;
            language: string;
            source: string;
            consent_scope: string;
            consent_revision: number;
            hash: string;
            item_count: number;
          }
        | undefined;
    },
    recordHoldout(input: { datasetVersion: string; splitSeed: string; items: string[] }) {
      const existing = db
        .prepare('SELECT id FROM learning_holdout_sets WHERE dataset_version=? AND split_seed=?')
        .get(input.datasetVersion, input.splitSeed) as { id: string } | undefined;
      if (existing) return existing.id;
      const id = 'ho-' + randomUUID();
      db.prepare(
        `INSERT INTO learning_holdout_sets (id, dataset_version, split_seed, items, created_at)
         VALUES (?,?,?,?,?)`,
      ).run(id, input.datasetVersion, input.splitSeed, JSON.stringify(input.items), now());
      return id;
    },
    holdoutBy(datasetVersion: string, splitSeed: string) {
      const row = db
        .prepare('SELECT items FROM learning_holdout_sets WHERE dataset_version=? AND split_seed=?')
        .get(datasetVersion, splitSeed) as { items: string } | undefined;
      return row ? (JSON.parse(row.items) as string[]) : undefined;
    },
    createRelease(input: {
      datasetVersion: string;
      previousReleaseId: string | null;
      createdBy: string;
    }) {
      const id = 'rel-' + randomUUID();
      const at = now();
      db.prepare(
        `INSERT INTO learning_releases
         (id, dataset_version, status, previous_release_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(id, input.datasetVersion, 'proposed', input.previousReleaseId, input.createdBy, at, at);
      return id;
    },
    release(id: string) {
      const row = releaseRow(id);
      return {
        ...row,
        canaries: db
          .prepare('SELECT * FROM learning_release_canaries WHERE release_id=? ORDER BY started_at')
          .all(id) as ReleaseCanaryRow[],
        approvals: db
          .prepare(
            'SELECT * FROM learning_release_approvals WHERE release_id=? ORDER BY created_at',
          )
          .all(id) as ReleaseApprovalRow[],
      };
    },
    listReleases(): ReleaseSummary[] {
      return db
        .prepare(
          'SELECT id, dataset_version AS datasetVersion, status, previous_release_id AS previousReleaseId, created_at AS createdAt FROM learning_releases ORDER BY created_at DESC',
        )
        .all() as ReleaseSummary[];
    },
    activeRelease(): ReleaseSummary | undefined {
      const rows = db
        .prepare(
          `SELECT id, dataset_version AS datasetVersion, status, previous_release_id AS previousReleaseId, created_at AS createdAt
           FROM learning_releases WHERE status IN ('live','canarying') ORDER BY created_at DESC LIMIT 1`,
        )
        .all() as ReleaseSummary[];
      return rows[0];
    },
    /** The newest live release, optionally excluding one id — the baseline
     * "what production runs today" for a canary gate. */
    latestLive(excludeId?: string): ReleaseSummary | undefined {
      const where = excludeId ? `WHERE status='live' AND id != ?` : `WHERE status='live'`;
      const rows = db
        .prepare(
          `SELECT id, dataset_version AS datasetVersion, status, previous_release_id AS previousReleaseId, created_at AS createdAt
           FROM learning_releases ${where} ORDER BY created_at DESC LIMIT 1`,
        )
        .all(...(excludeId ? [excludeId] : [])) as ReleaseSummary[];
      return rows[0];
    },
    setStatus,
    recordApproval,
    startCanary(input: { releaseId: string; stage: CanaryStage; cohortPct: number }) {
      releaseRow(input.releaseId);
      const id = 'can-' + randomUUID();
      db.prepare(
        `INSERT INTO learning_release_canaries
         (id, release_id, stage, cohort_pct, status, started_at, completed_at, metrics_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, input.releaseId, input.stage, input.cohortPct, 'running', now(), null, '{}');
      return id;
    },
    completeCanary(input: {
      canaryId: string;
      outcome: 'passed' | 'blocked';
      metricsJson: string;
    }) {
      const row = db
        .prepare('SELECT * FROM learning_release_canaries WHERE id=?')
        .get(input.canaryId) as
        { id: string; release_id: string; stage: string; status: string } | undefined;
      if (!row)
        throw new LearningReleaseError(
          'unknown-canary',
          `Canary ${input.canaryId} does not exist.`,
          404,
        );
      if (row.status !== 'running')
        throw new LearningReleaseError(
          'invalid-release-state',
          `Canary ${input.canaryId} is already ${row.status}.`,
          409,
        );
      db.prepare(
        'UPDATE learning_release_canaries SET status=?, completed_at=?, metrics_json=? WHERE id=?',
      ).run(input.outcome, now(), input.metricsJson, input.canaryId);
      if (input.outcome === 'passed' && row.stage === 'canary-100pct') {
        setStatus(row.release_id, 'live', ['canarying']);
        // The release this one superseded steps aside; its rows stay.
        const release = releaseRow(row.release_id);
        if (release.previousReleaseId) {
          const previous = releaseRow(release.previousReleaseId);
          if (previous.status === 'live') setStatus(previous.id, 'superseded', ['live']);
        }
      }
    },
    lastPassedMetrics(releaseId: string): Record<string, LanguageMetrics> | null {
      const row = db
        .prepare(
          `SELECT metrics_json FROM learning_release_canaries
           WHERE release_id=? AND status='passed' ORDER BY completed_at DESC LIMIT 1`,
        )
        .get(releaseId) as { metrics_json: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.metrics_json) as {
          perLanguage?: Record<string, LanguageMetrics>;
        };
        return parsed.perLanguage ?? null;
      } catch {
        return null;
      }
    },
    /** First-class rollback: deactivate the release, reactivate the one it
     * superseded, record the decision. Nothing is deleted. */
    rollback(input: { releaseId: string; approver: string; reason: string }) {
      return transaction(() => {
        const row = releaseRow(input.releaseId);
        if (row.status !== 'live' && row.status !== 'canarying')
          throw new LearningReleaseError(
            'invalid-release-state',
            `Release ${input.releaseId} is ${row.status}; only a live or canarying release can be rolled back.`,
            409,
          );
        if (!row.previousReleaseId)
          throw new LearningReleaseError(
            'nothing-to-rollback',
            'This release supersedes nothing — there is no previous version to restore.',
            409,
          );
        const previous = releaseRow(row.previousReleaseId);
        db.prepare('UPDATE learning_releases SET status=?, updated_at=? WHERE id=?').run(
          'rolled-back',
          now(),
          row.id,
        );
        db.prepare('UPDATE learning_releases SET status=?, updated_at=? WHERE id=?').run(
          'live',
          now(),
          previous.id,
        );
        recordApproval({
          releaseId: row.id,
          approver: input.approver,
          decision: 'rollback',
          reason: input.reason,
        });
        return { deactivated: row.id, reactivated: previous.id };
      });
    },
  };
}
