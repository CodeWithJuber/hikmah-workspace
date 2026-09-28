/** The single run pipeline.
 *
 * Every run in the product goes through `enqueueRun` — the chat turn route and
 * the background-task route both call it instead of `store.createRun`
 * directly. It owns, in order:
 *
 *  1. idempotency: an idempotency key always resolves to the same run id, so
 *     a retried or double-submitted request never starts a second run;
 *  2. the active-run cap: at most `enqueueCap()` unfinished runs per owner
 *     (the worker's own concurrency, so the queue cannot grow past what the
 *     worker will actually drive). At the cap it throws EnqueueFullError and
 *     the route answers 429;
 *  3. arm selection: the v5 policy picks a workflow arm, or the caller
 *     overrides with an explicit arm (validated against eligibility — the
 *     policy never overrides eligibility);
 *  4. budget allocation: per-arm defaults from ARM_CALL_CAP, caller overrides
 *     win, stamped onto the run config;
 *  5. the row itself, via store.createRun.
 *
 * Worker handoff: enqueueRun only queues. The existing worker claims the run
 * through its claimNext polling loop (lib/runs/worker.ts `tick`, plus the
 * routes' nudge `void worker.tick()` after enqueue) — verified, not changed.
 *
 * No behavior change for existing callers except through the policy, which
 * starts on its fallback prior: with zero feedback the selection is 'direct',
 * exactly what the pipeline did before the policy existed. The honest
 * bootstrap — outcomes only diverge once feedback accrues.
 *
 * Stores are injected (no globals) so this is testable without a server.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { RunStore } from './store.ts';
import type { WorkflowStore } from '../workflow/store.ts';
import { ARM_CALL_CAP, type WorkflowArm } from '../workflow/arms.ts';
import {
  initialPolicyState,
  extractFeatures,
  eligibleArms,
  selectArm,
  type FeatureContext,
  type EligibilityInput,
  type ArmScore,
} from '../workflow/policy.ts';
import type { Budget } from '../workflow/budget.ts';
import { runConcurrency } from './concurrency.ts';

/** What the policy needs to decide. The routes build this from the request;
 * absent means "behave exactly as today": a keyed remote run. */
export type SelectionContext = {
  promptText: string;
  taskCategory: string;
  hasProviderKey: boolean;
  localFrame: { supported: boolean; confidence: number; threshold: number } | null;
};

export type EnqueueSelection =
  /** The policy chose. Scores are model judgments (LinUCB upper bounds),
   * never probabilities of correctness. */
  | { scores: Record<string, number>; propensity: number; featureVersion: number }
  /** The caller named the arm. No sampling happened, so there is no
   * propensity to log. */
  | { overridden: true };

/** Thrown when the owner already has `cap` unfinished runs. The route turns
 * this into a 429; it is typed so callers can distinguish "try later" from a
 * real failure. */
export class EnqueueFullError extends Error {
  readonly active: number;
  readonly cap: number;
  constructor(active: number, cap: number) {
    super(
      `Too many runs are already in progress (${active} of ${cap} slots). ` +
        'Wait for one to finish.',
    );
    this.name = 'EnqueueFullError';
    this.active = active;
    this.cap = cap;
  }
}

/** Non-call budget defaults. Sane, not scientific: 128k tokens, $2, ten
 * minutes. maxCalls always comes from ARM_CALL_CAP per arm; these are the
 * other three legs, tunable per deployment. */
export const DEFAULT_BUDGET: Omit<Budget, 'maxCalls'> = {
  maxTokens: 128_000,
  maxCost: 2,
  deadlineMs: 10 * 60 * 1000,
};

/** How many unfinished runs one owner may have: the worker's own concurrency,
 * read live from HIKMAH_RUN_CONCURRENCY so tests and operators see the same
 * number the worker drives with. */
export function enqueueCap(): number {
  return runConcurrency(process.env.HIKMAH_RUN_CONCURRENCY);
}

/** Exploration rate for arm selection. Zero while the feedback loop is being
 * wired end-to-end: with epsilon > 0 the policy would explore other arms
 * before any feedback exists, which breaks the honest bootstrap (selection
 * must be identical to today's until feedback accrues). Raise only with an
 * explicit exploration schedule from the policy owner. */
const ENQUEUE_EPSILON = 0;

/** Deterministic PRNG seeded from the run id: arm selection is replayable
 * given the run id, without being deterministic across runs. */
function seededRng(seed: string): () => number {
  const hash = createHash('sha256').update(seed, 'utf8').digest();
  let state = hash.readUInt32BE(0) || 1;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultSelectionContext(): SelectionContext {
  return { promptText: '', taskCategory: 'general', hasProviderKey: true, localFrame: null };
}

/** The workflow stamp of a run already in the store — for idempotency hits. */
function storedWorkflow(
  store: RunStore,
  runId: string,
): { arm: WorkflowArm; selection: EnqueueSelection } {
  try {
    const workflow = (JSON.parse(store.getRun(runId)?.config ?? '{}') as { workflow?: unknown })
      .workflow as { arm?: unknown; selection?: unknown } | undefined;
    if (workflow && typeof workflow.arm === 'string')
      return {
        arm: workflow.arm as WorkflowArm,
        selection: (workflow.selection as EnqueueSelection) ?? { overridden: true },
      };
  } catch {
    /* a row from before the workflow stamp existed */
  }
  // Pre-policy runs were always the direct remote answer.
  return { arm: 'direct', selection: { overridden: true } };
}

export function enqueueRun(opts: {
  userId: string;
  conversationId: string;
  runId?: string;
  /** The run config the call sites already build. Stamped additively with
   * `{ arm, budget, selection }` under `config.workflow`; every other field
   * is kept exactly as the caller built it. */
  config: unknown;
  /** Caller tier; keeps the 0013 priority semantics. */
  priority?: number;
  /** Dedupe key: same key → same run id, no second run. */
  idempotencyKey?: string;
  /** Explicit arm. Skips the policy but never skips eligibility — throws
   * when the arm is not eligible for this run. */
  arm?: WorkflowArm;
  /** Overrides the per-arm budget defaults. */
  budget?: Partial<Budget>;
  selection?: SelectionContext;
  store: RunStore;
  workflowStore?: WorkflowStore;
}): { runId: string; arm: WorkflowArm; selection: EnqueueSelection } {
  const { store } = opts;
  const runId = opts.runId ?? 'run_' + randomUUID();
  const key = opts.idempotencyKey;

  // A retry must return the original run before any cap or selection work —
  // answering 429 to a retry of a run that already exists would be wrong.
  if (key) {
    const hit = store.idempotencyHit(key);
    if (hit) {
      const { arm, selection } = storedWorkflow(store, hit);
      return { runId: hit, arm, selection };
    }
  }

  const active = store.countActive(opts.userId);
  const cap = enqueueCap();
  if (active >= cap) throw new EnqueueFullError(active, cap);

  const ctx = opts.selection ?? defaultSelectionContext();
  // The policy's feature/eligibility inputs need a budget envelope, but the
  // final budget's maxCalls depends on the chosen arm. Use a provisional
  // envelope with the largest arm cap here — the final budget below narrows
  // maxCalls to the selected arm (caller overrides win in both).
  const provisionalBudget: Budget = {
    maxCalls: Math.max(...Object.values(ARM_CALL_CAP)),
    ...DEFAULT_BUDGET,
    ...(opts.budget ?? {}),
  };
  const eligibilityInput: EligibilityInput = {
    hasProviderKey: ctx.hasProviderKey,
    local: ctx.localFrame
      ? {
          supported: ctx.localFrame.supported,
          confidence: ctx.localFrame.confidence,
          threshold: ctx.localFrame.threshold,
        }
      : null,
    budget: provisionalBudget,
  };
  const eligible = eligibleArms(eligibilityInput);
  let arm: WorkflowArm;
  let selection: EnqueueSelection;
  if (opts.arm) {
    if (!eligible.includes(opts.arm))
      throw new Error(
        `Arm "${opts.arm}" is not eligible for this run ` +
          `(eligible: ${eligible.join(', ') || 'none'}). The policy never overrides eligibility.`,
      );
    arm = opts.arm;
    selection = { overridden: true };
  } else {
    const featureContext: FeatureContext = {
      prompt: ctx.promptText,
      taskCategory: ctx.taskCategory,
      constraintCount: 0,
      availableSources: 0,
      budget: provisionalBudget,
      priorFailureTags: [],
      // The co-model's own competence estimate, when it reported a frame.
      localCompetence: ctx.localFrame?.supported ? ctx.localFrame.confidence : 0,
    };
    const features = extractFeatures(featureContext);
    const policy = opts.workflowStore?.loadPolicyState() ?? initialPolicyState();
    const result = selectArm(eligible, features, policy, {
      epsilon: ENQUEUE_EPSILON,
      rng: seededRng(runId),
    });
    arm = result.arm;
    selection = {
      scores: Object.fromEntries(result.scores.map((s: ArmScore) => [s.arm, s.score])),
      propensity: result.propensity,
      featureVersion: result.featureVersion,
    };
    // The full ArmScore array (score + fallback flag per arm), not just the
    // record above: the inspection view needs to know which arms scored on
    // the fallback prior.
    opts.workflowStore?.logPropensity(
      runId,
      arm,
      result.propensity,
      result.featureVersion,
      result.scores,
    );
  }

  const budget: Budget = {
    maxCalls: ARM_CALL_CAP[arm],
    ...DEFAULT_BUDGET,
    ...(opts.budget ?? {}),
  };
  const config = {
    ...(opts.config as Record<string, unknown> | undefined),
    workflow: { arm, budget, selection },
  };

  // Claimed after selection so the claim window is small; a lost race re-reads
  // the winner rather than creating a second run.
  if (key && !store.claimIdempotency(key, runId)) {
    const hit = store.idempotencyHit(key);
    if (hit) {
      const { arm: wonArm, selection: wonSelection } = storedWorkflow(store, hit);
      return { runId: hit, arm: wonArm, selection: wonSelection };
    }
    // Claimed between the check and the read by a run that has since been
    // deleted: fall through and create ours.
  }

  store.createRun({
    id: runId,
    conversationId: opts.conversationId,
    userId: opts.userId,
    priority: opts.priority,
    config,
  });
  return { runId, arm, selection };
}
