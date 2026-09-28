/**
 * lib/workflow/policy.ts — LinUCB arm-selection policy (phase3-spec §3.2,
 * docs/v5/research.md §"The policy learner").
 *
 * A disjoint linear contextual bandit per eligible workflow arm:
 *   A_a = λI, b_a = 0;  θ_a = A_a⁻¹ b_a;
 *   score_a(x) = θ_aᵀx + α√(xᵀ A_a⁻¹ x)
 *
 * HONESTY CONTRACT (v5, verbatim semantics):
 * - Policy scores are MODEL JUDGMENTS (LinUCB upper bounds), never
 *   probabilities of correctness. The UI must label them as such.
 * - While feedback is sparse, every arm scores with the fixed fallback prior,
 *   so selection is identical to today's behavior — the honest bootstrap.
 * - Epsilon exploration runs only within the already-allowed eligible arms;
 *   the exact p(a|x) is logged for replayability (seeded PRNG).
 * - Update on ONE eligible final outcome per run. A missing rating is NOT
 *   success (applied: false). Replaced feedback supersedes via event-log
 *   replay; callers must dedupe by Feedback.id before calling policyUpdate —
 *   this module applies every call it receives.
 * - Do not combine subjective preference and objective correctness into one
 *   unlabelled accuracy statistic: quality/cost/latency stay visible
 *   separately in the returned reward breakdown.
 *
 * Pure logic — persistence (SQLite) is another worker's module and consumes
 * serializePolicyState / deserializePolicyState / policyUpdate.
 */

import { ARMS, type WorkflowArm } from './arms.ts';
import type { Budget } from './budget.ts';

/** Feature schema version. Bump when extractFeatures' order/meaning changes. */
export const FEATURE_VERSION = 1;
/** Feature vector length. */
export const FEATURE_DIM = 10;

/** Ridge regularization λ: A_a starts at λI. */
export const LAMBDA = 1;
/** Exploration coefficient α in score_a(x). Heuristic, not measured. */
export const ALPHA = 1;
/** λ_cost in r = q − λ_cost·min(cost/budget,1) − λ_time·min(latency/deadline,1). */
export const LAMBDA_COST = 0.5;
/** λ_time in the same utility. */
export const LAMBDA_TIME = 0.3;

/**
 * Sparsity threshold: an arm whose effective weighted update mass
 * (trace(A_a) − d·λ) is below this counts as "feedback sparse" and scores with
 * the fixed fallback prior instead of its learned (A, b). One full weighted
 * update is the minimum evidence for leaving the prior.
 */
export const SPARSE_UPDATE_THRESHOLD = 1;

export interface ArmStats {
  A: number[][];
  b: number[];
}

/** Learned state: versioned envelope + per-arm sufficient statistics. */
export interface PolicyState {
  version: number;
  arms: Record<WorkflowArm, ArmStats>;
}

// ---------------------------------------------------------------------------
// Small matrix helpers (dim ~10; plain Gaussian elimination is plenty).
// ---------------------------------------------------------------------------

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function identityScaled(n: number, scale: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? scale : 0)),
  );
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Solve A·v = rhs via Gauss-Jordan with partial pivoting. Throws if singular. */
function solveLinear(A: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  if (A.length !== n || A.some((row) => row.length !== n)) {
    throw new Error('solveLinear: A must be square and match rhs length');
  }
  const M = A.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (!Number.isFinite(M[pivot][col]) || Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error('solveLinear: singular matrix');
    }
    const tmp = M[col];
    M[col] = M[pivot];
    M[pivot] = tmp;
    const d = M[col][col];
    for (let j = 0; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f !== 0) {
        for (let j = 0; j <= n; j++) M[r][j] -= f * M[col][j];
      }
    }
  }
  return M.map((row) => row[n]);
}

function trace(A: number[][]): number {
  let t = 0;
  for (let i = 0; i < A.length; i++) t += A[i][i];
  return t;
}

// ---------------------------------------------------------------------------
// State construction / (de)serialization.
// ---------------------------------------------------------------------------

/** Fresh state: A_a = λI, b_a = 0 for every arm. */
export function initialPolicyState(): PolicyState {
  const arms = {} as Record<WorkflowArm, ArmStats>;
  for (const arm of ARMS) {
    arms[arm] = { A: identityScaled(FEATURE_DIM, LAMBDA), b: zeros(FEATURE_DIM) };
  }
  return { version: FEATURE_VERSION, arms };
}

/** Whole-state JSON blob for the persistence layer (stored per-arm or whole). */
export function serializePolicyState(s: PolicyState): string {
  return JSON.stringify(s);
}

function assertArmStats(name: string, v: unknown, dim: number): asserts v is ArmStats {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`deserializePolicyState: arm '${name}' is not an object`);
  }
  const { A, b } = v as { A?: unknown; b?: unknown };
  if (!Array.isArray(A) || A.length !== dim) {
    throw new Error(`deserializePolicyState: arm '${name}' A must be ${dim}x${dim}`);
  }
  for (let i = 0; i < dim; i++) {
    const row = A[i];
    if (
      !Array.isArray(row) ||
      row.length !== dim ||
      row.some((x) => typeof x !== 'number' || !Number.isFinite(x))
    ) {
      throw new Error(
        `deserializePolicyState: arm '${name}' A[${i}] must be ${dim} finite numbers`,
      );
    }
  }
  if (
    !Array.isArray(b) ||
    b.length !== dim ||
    b.some((x) => typeof x !== 'number' || !Number.isFinite(x))
  ) {
    throw new Error(`deserializePolicyState: arm '${name}' b must be ${dim} finite numbers`);
  }
}

/**
 * Parse + validate a serialized state. Throws on any bad shape: invalid
 * JSON, version mismatch, missing arm, non-square/non-finite A or b, or
 * inconsistent dimensions across arms. A version mismatch means the caller
 * must migrate — never silently coerce.
 */
export function deserializePolicyState(json: string): PolicyState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('deserializePolicyState: invalid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('deserializePolicyState: top level must be an object');
  }
  const { version, arms } = raw as { version?: unknown; arms?: unknown };
  if (version !== FEATURE_VERSION) {
    throw new Error(
      `deserializePolicyState: version ${String(version)} != FEATURE_VERSION ${FEATURE_VERSION}`,
    );
  }
  if (typeof arms !== 'object' || arms === null) {
    throw new Error('deserializePolicyState: missing arms object');
  }
  const armObjs = arms as Record<string, unknown>;
  const first = armObjs[ARMS[0]] as { A?: unknown } | undefined;
  const dim = Array.isArray(first?.A) ? (first.A as unknown[]).length : 0;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error('deserializePolicyState: cannot determine feature dimension');
  }
  const out = {} as Record<WorkflowArm, ArmStats>;
  for (const arm of ARMS) {
    const v = armObjs[arm];
    assertArmStats(arm, v, dim);
    out[arm] = v;
  }
  return { version: FEATURE_VERSION, arms: out };
}

// ---------------------------------------------------------------------------
// Features.
// ---------------------------------------------------------------------------

export interface FeatureContext {
  prompt: string;
  taskCategory: string;
  constraintCount: number;
  availableSources: number;
  budget: Budget;
  priorFailureTags: string[];
  localCompetence: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Heuristic feature extraction, versioned by FEATURE_VERSION.
 *
 * Feature order (v1) — keep this comment in sync with the code:
 *   0 prompt_len            prompt.length / 4000, clamped to [0,1]
 *   1 code_indicator        0/1: prompt contains code markers
 *   2 numeric_indicator     0/1: prompt has digits in a quantitative context
 *   3 task_category         FNV-1a(taskCategory) / 2^32 → [0,1)
 *   4 constraint_count      constraintCount / 10, clamped to [0,1]
 *   5 available_sources     availableSources / 10, clamped to [0,1]
 *   6 budget                budget.maxCalls / 8 (largest arm cap), clamped
 *   7 prior_failure_tags    priorFailureTags.length / 5, clamped to [0,1]
 *   8 prior_failure_any     0/1
 *   9 local_competence      clamped to [0,1]
 *
 * Always returns exactly FEATURE_DIM values in [0,1]. Heuristic, not
 * measured: treat as model-judgment inputs, not calibrated predictors.
 */
export function extractFeatures(ctx: FeatureContext): number[] {
  const prompt = ctx.prompt ?? '';
  const code = /(```|=>|\bfunction\b|\bdef\b|\bclass\b|\bconst\b|\bimport\b|#include\b|=>)/.test(
    prompt,
  )
    ? 1
    : 0;
  const numeric =
    /\d/.test(prompt) &&
    /[+\-*/%^=]|\b(sum|mean|average|total|calculate|compute|solve|equation|percent)\b/i.test(prompt)
      ? 1
      : 0;
  return [
    clamp01(prompt.length / 4000),
    code,
    numeric,
    fnv1a(ctx.taskCategory ?? '') / 4294967296,
    clamp01((ctx.constraintCount ?? 0) / 10),
    clamp01((ctx.availableSources ?? 0) / 10),
    clamp01((ctx.budget?.maxCalls ?? 0) / 8),
    clamp01((ctx.priorFailureTags ?? []).length / 5),
    (ctx.priorFailureTags ?? []).length > 0 ? 1 : 0,
    clamp01(ctx.localCompetence ?? 0),
  ];
}

// ---------------------------------------------------------------------------
// Eligibility — the policy never overrides this.
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  hasProviderKey: boolean;
  local: { supported: boolean; confidence: number; threshold: number } | null;
  /**
   * Accepted for forward compatibility (budget-shaped features feed
   * extractFeatures). Arm budget caps are enforced by the budget ledger at
   * execution time, not here — eligibility stays exactly: local on
   * co-model support, remote arms on provider key.
   */
  budget: Budget;
}

/**
 * Eligible arms for this run, in ARMS order.
 * - `local` only when the co-model reports a supported frame with
 *   confidence >= its dev-gate threshold.
 * - arms requiring remote calls only when a provider key is configured.
 * The policy never overrides eligibility: selectArm only chooses among these.
 */
export function eligibleArms(input: EligibilityInput): WorkflowArm[] {
  const out: WorkflowArm[] = [];
  const local = input.local;
  if (local && local.supported && local.confidence >= local.threshold) {
    out.push('local');
  }
  if (input.hasProviderKey) {
    out.push('direct', 'verify-repair', 'decompose', 'explore-consensus');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

export interface ArmScore {
  arm: WorkflowArm;
  /**
   * MODEL JUDGMENT, not a probability of correctness: the LinUCB upper bound
   * θ_aᵀx + α√(xᵀA_a⁻¹x), or 0 under the fallback prior.
   */
  score: number;
  /** True when this arm scored with the fixed fallback prior (feedback sparse). */
  isFallback: boolean;
}

export interface Selection {
  arm: WorkflowArm;
  /** Every eligible arm, sorted by score desc (ARMS order breaks ties). */
  scores: ArmScore[];
  /** Exact logged p(a|x) = epsilon/K + (1-epsilon)·1[a=best]. */
  propensity: number;
  featureVersion: number;
}

export interface SelectOptions {
  /** Exploration rate in [0,1]. Exploration stays within eligible arms. */
  epsilon: number;
  /** Seeded PRNG: selection is replayable, provider outputs are not. */
  rng: () => number;
  /** Override the exploration coefficient α (default ALPHA). */
  alpha?: number;
}

function armDim(state: PolicyState): number {
  return state.arms[ARMS[0]].b.length;
}

/**
 * Choose an arm by disjoint LinUCB with epsilon-greedy exploration.
 *
 * - Sparse arms (update mass below SPARSE_UPDATE_THRESHOLD) score 0 with the
 *   fixed fallback prior; learned arms score θ_aᵀx + α√(xᵀA_a⁻¹x). With no
 *   feedback at all, every arm ties at 0 and the first eligible arm wins —
 *   identical to today's behavior (the honest bootstrap).
 * - Greedy pick is the top scorer (ties → ARMS order). With probability
 *   epsilon, pick uniformly among eligible arms instead.
 * - propensity = epsilon/K + (1-epsilon)·1[chosen=best], logged exactly.
 */
export function selectArm(
  eligible: WorkflowArm[],
  x: number[],
  state: PolicyState,
  opts: SelectOptions,
): Selection {
  if (eligible.length === 0) throw new Error('selectArm: no eligible arms');
  if (state.version !== FEATURE_VERSION) {
    throw new Error(
      `selectArm: state version ${state.version} != FEATURE_VERSION ${FEATURE_VERSION}`,
    );
  }
  const d = armDim(state);
  if (x.length !== d) {
    throw new Error(`selectArm: feature dim ${x.length} != state dim ${d}`);
  }
  const epsilon = opts.epsilon;
  if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
    throw new Error('selectArm: epsilon must be in [0,1]');
  }
  const alpha = opts.alpha ?? ALPHA;

  const scores: ArmScore[] = eligible.map((arm) => {
    const stats = state.arms[arm];
    if (!stats) throw new Error(`selectArm: unknown arm '${arm}'`);
    const updateMass = trace(stats.A) - d * LAMBDA;
    if (updateMass < SPARSE_UPDATE_THRESHOLD) {
      return { arm, score: 0, isFallback: true };
    }
    const theta = solveLinear(stats.A, stats.b);
    const mean = dot(theta, x);
    const AinvX = solveLinear(stats.A, x);
    const width = Math.sqrt(Math.max(0, dot(x, AinvX)));
    return { arm, score: mean + alpha * width, isFallback: false };
  });

  const order = new Map<WorkflowArm, number>(ARMS.map((a, i) => [a, i]));
  scores.sort((a, b) => b.score - a.score || (order.get(a.arm) ?? 0) - (order.get(b.arm) ?? 0));
  const best = scores[0].arm;

  let chosen: WorkflowArm;
  if (epsilon > 0 && opts.rng() < epsilon) {
    chosen = eligible[Math.floor(opts.rng() * eligible.length)];
  } else {
    chosen = best;
  }

  const K = eligible.length;
  const propensity = epsilon / K + (1 - epsilon) * (chosen === best ? 1 : 0);

  return { arm: chosen, scores, propensity, featureVersion: FEATURE_VERSION };
}

// ---------------------------------------------------------------------------
// Feedback / update.
// ---------------------------------------------------------------------------

/** One eligible final outcome per run. */
export interface Feedback {
  /** Id for dedupe — the caller (event log) guarantees one application per id. */
  id: string;
  arm: WorkflowArm;
  x: number[];
  /**
   * Explicit user quality or independently graded correctness in [0,1].
   * null = missing rating. A MISSING RATING IS NOT SUCCESS: the update is
   * skipped (applied: false) rather than counted as a win.
   */
  quality: number | null;
  cost: number;
  budget: number;
  latencyMs: number;
  deadlineMs: number;
  weight?: number;
}

export interface RewardBreakdown {
  /** r = q − λ_cost·min(cost/budget,1) − λ_time·min(latency/deadline,1). */
  total: number;
  /** Quality component q (kept visible separately). */
  quality: number;
  /** Cost component min(cost/budget,1) (kept visible separately). */
  cost: number;
  /** Latency component min(latency/deadline,1) (kept visible separately). */
  latency: number;
}

export interface PolicyUpdateResult {
  state: PolicyState;
  applied: boolean;
  reward: RewardBreakdown | null;
}

/**
 * Apply one eligible final outcome: A_a += w·x·xᵀ, b_a += w·x·r.
 *
 * Returns a new PolicyState (other arms shared by reference — treat states as
 * immutable). Missing quality (null) → { state, applied: false, reward: null }:
 * no silent success is ever recorded. The caller must dedupe by Feedback.id
 * (event-log replay) — every call here applies.
 */
export function policyUpdate(state: PolicyState, fb: Feedback): PolicyUpdateResult {
  const stats = state.arms[fb.arm];
  if (!stats) throw new Error(`policyUpdate: unknown arm '${String(fb.arm)}'`);
  const d = stats.b.length;
  if (fb.x.length !== d) {
    throw new Error(`policyUpdate: feature dim ${fb.x.length} != state dim ${d}`);
  }
  if (fb.x.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('policyUpdate: features must be finite numbers');
  }

  // Missing rating ≠ success. Skip the update entirely.
  if (fb.quality === null || fb.quality === undefined) {
    return { state, applied: false, reward: null };
  }

  const w = fb.weight ?? 1;
  if (!Number.isFinite(w) || w < 0) {
    throw new Error('policyUpdate: weight must be a non-negative finite number');
  }

  const q = clamp01(fb.quality);
  const costFrac = fb.budget > 0 ? Math.min(fb.cost / fb.budget, 1) : fb.cost > 0 ? 1 : 0;
  const latencyFrac =
    fb.deadlineMs > 0 ? Math.min(fb.latencyMs / fb.deadlineMs, 1) : fb.latencyMs > 0 ? 1 : 0;
  const r = q - LAMBDA_COST * costFrac - LAMBDA_TIME * latencyFrac;

  const A = stats.A.map((row, i) => row.map((v, j) => v + w * fb.x[i] * fb.x[j]));
  const b = stats.b.map((v, i) => v + w * fb.x[i] * r);
  const next: PolicyState = {
    version: state.version,
    arms: { ...state.arms, [fb.arm]: { A, b } },
  };
  return {
    state: next,
    applied: true,
    reward: { total: r, quality: q, cost: costFrac, latency: latencyFrac },
  };
}
