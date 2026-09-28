/** Persistence for the v5 control layer's learned state.
 *
 * Built on the raw node:sqlite handle, following lib/runs/store.ts: prepared
 * statements, no ORM. Tables come from drizzle/0020_workflow_policy.sql.
 *
 * Replaced (superseded) feedback is NOT handled here: the caller replays the
 * feedback event log and re-applies, and the duplicate-id guard below makes
 * the replay safe. This store only guarantees one application per id.
 */
import type { SqliteHandle } from '../runs/store.ts';
import type { PolicyState, Feedback } from './policy.ts';
import {
  FEATURE_VERSION,
  initialPolicyState,
  serializePolicyState,
  deserializePolicyState,
  policyUpdate,
} from './policy.ts';
import type { WorkflowArm } from './arms.ts';

export type OutcomeRow = {
  stateKey: string;
  arm: string;
  outcome: string;
  count: number;
};

export type FeedbackRow = {
  feedbackId: string;
  arm: string;
  reward: unknown;
  createdAt: string;
};

export type PropensityRow = {
  id: number;
  runId: string;
  arm: string;
  propensity: number;
  featureVersion: number;
  scores: unknown;
  createdAt: string;
};

export function createWorkflowStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    allPolicy: db.prepare('SELECT arm, state_json FROM workflow_policy'),
    upsertPolicy: db.prepare(
      `INSERT INTO workflow_policy (arm, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (arm) DO UPDATE SET state_json = excluded.state_json,
                                       updated_at = excluded.updated_at`,
    ),
    hasFeedback: db.prepare('SELECT 1 AS found FROM workflow_feedback WHERE feedback_id = ?'),
    insertFeedback: db.prepare(
      `INSERT INTO workflow_feedback (feedback_id, arm, reward_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ),
    recentFeedback: db.prepare(
      `SELECT feedback_id, arm, reward_json, created_at FROM workflow_feedback
       ORDER BY created_at DESC, feedback_id DESC LIMIT ?`,
    ),
    insertPropensity: db.prepare(
      `INSERT INTO workflow_propensity
         (run_id, arm, propensity, feature_version, scores_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    recentPropensity: db.prepare(
      `SELECT id, run_id, arm, propensity, feature_version, scores_json, created_at
       FROM workflow_propensity ORDER BY id DESC LIMIT ?`,
    ),
    outcomeRows: db.prepare('SELECT state_key, arm, outcome, count FROM workflow_outcomes'),
    upsertOutcome: db.prepare(
      `INSERT INTO workflow_outcomes (state_key, arm, outcome, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (state_key, arm, outcome)
       DO UPDATE SET count = workflow_outcomes.count + 1`,
    ),
  };

  const one = <T>(value: unknown): T | null => (value ?? null) as T | null;

  /** Per-arm JSON, decomposed from Worker's A whole-state serialization.
   *
   * serializePolicyState/deserializePolicyState own the whole PolicyState,
   * which is a versioned envelope `{ version, arms: { [arm]: {A, b} } }` —
   * but the table is one row per arm. So the store splits the envelope's
   * `arms` object into per-arm blobs on save and reassembles the envelope on
   * load. If the envelope shape ever changes, this is the one place to
   * change. */
  function splitPerArm(state: PolicyState): Array<{ arm: string; json: string }> {
    const whole = JSON.parse(serializePolicyState(state)) as {
      version?: unknown;
      arms?: Record<string, unknown>;
    };
    if (!whole || typeof whole !== 'object' || !whole.arms || typeof whole.arms !== 'object')
      throw new Error('splitPerArm: serialized policy state has no arms object');
    return Object.entries(whole.arms).map(([arm, armState]) => ({
      arm,
      json: JSON.stringify(armState),
    }));
  }

  function savePolicyState(state: PolicyState): void {
    const stamp = now();
    for (const { arm, json } of splitPerArm(state)) statements.upsertPolicy.run(arm, json, stamp);
  }

  function loadPolicyState(): PolicyState {
    const rows = statements.allPolicy.all() as Array<{ arm: string; state_json: string }>;
    if (!rows.length) return initialPolicyState();
    const arms: Record<string, unknown> = {};
    for (const row of rows) arms[row.arm] = JSON.parse(row.state_json);
    return deserializePolicyState(JSON.stringify({ version: FEATURE_VERSION, arms }));
  }

  return {
    /** The learned policy, or the fallback prior when nothing has been learned
     * yet. The prior is identical to "no policy" — see selectArm's fallback. */
    loadPolicyState,
    savePolicyState,

    /**
     * Apply one run's final outcome to the policy, idempotently.
     *
     * A feedback id seen before is ignored — { applied: false, duplicate:
     * true } — so a retried webhook or a replayed log can never move the
     * policy twice for the same outcome. The caller chooses the id (one per
     * run's final outcome, per the spec); the store only enforces uniqueness.
     *
     * A missing quality rating is not success: policyUpdate reports
     * applied:false and the state is left untouched, but the id is still
     * recorded so a replay does not reconsider it. The reward breakdown
     * (quality/cost/latency kept separate) is what the inspection view reads.
     */
    recordFeedback(feedback: Feedback): { applied: boolean; duplicate: boolean } {
      const feedbackId = feedback.id ?? (feedback as { feedback_id?: unknown }).feedback_id;
      if (typeof feedbackId !== 'string' || !feedbackId) throw new Error('Feedback needs an id.');
      if (one<{ found: number }>(statements.hasFeedback.get(feedbackId)))
        return { applied: false, duplicate: true };
      const result = policyUpdate(loadPolicyState(), feedback);
      if (result.applied) savePolicyState(result.state);
      statements.insertFeedback.run(feedbackId, feedback.arm, JSON.stringify(result.reward), now());
      return { applied: result.applied, duplicate: false };
    },

    /** One row per arm selection: exact propensity, scores and feature version,
     * so the superadmin view can replay what the policy saw. `scores` is the
     * policy's ArmScore array (score + fallback flag per eligible arm). */
    logPropensity(
      runId: string,
      arm: WorkflowArm,
      propensity: number,
      featureVersion: number,
      scores: unknown,
    ): void {
      statements.insertPropensity.run(
        runId,
        arm,
        propensity,
        featureVersion,
        JSON.stringify(scores),
        now(),
      );
    },

    /** Every observed (state, arm, outcome) count. Never written from
     * predictions — the caller only records genuinely observed outcomes. */
    loadOutcomeCounts(): OutcomeRow[] {
      return (
        statements.outcomeRows.all() as Array<{
          state_key: string;
          arm: string;
          outcome: string;
          count: number;
        }>
      ).map((row) => ({
        stateKey: row.state_key,
        arm: row.arm,
        outcome: row.outcome,
        count: row.count,
      }));
    },

    /** Count one observed terminal outcome. Accumulates; never resets. */
    recordOutcome(stateKey: string, arm: WorkflowArm, outcome: string): void {
      statements.upsertOutcome.run(stateKey, arm, outcome);
    },

    /** Newest feedback first, for the superadmin policy-inspection view. */
    recentUpdates(limit: number): FeedbackRow[] {
      return (
        statements.recentFeedback.all(Math.max(1, Math.trunc(limit))) as Array<{
          feedback_id: string;
          arm: string;
          reward_json: string;
          created_at: string;
        }>
      ).map((row) => ({
        feedbackId: row.feedback_id,
        arm: row.arm,
        reward: JSON.parse(row.reward_json),
        createdAt: row.created_at,
      }));
    },

    /** Newest selections first, for the superadmin policy-inspection view. */
    recentPropensities(limit: number): PropensityRow[] {
      return (
        statements.recentPropensity.all(Math.max(1, Math.trunc(limit))) as Array<{
          id: number;
          run_id: string;
          arm: string;
          propensity: number;
          feature_version: number;
          scores_json: string;
          created_at: string;
        }>
      ).map((row) => ({
        id: row.id,
        runId: row.run_id,
        arm: row.arm,
        propensity: row.propensity,
        featureVersion: row.feature_version,
        scores: JSON.parse(row.scores_json),
        createdAt: row.created_at,
      }));
    },
  };
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;
