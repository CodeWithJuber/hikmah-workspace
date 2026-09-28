/**
 * lib/workflow/outcomes.ts — Learned outcome model (phase3-spec §3.3,
 * docs/v5/research.md §"Learned outcome model").
 *
 * State abstraction: (task_category, interpretation_known|unknown,
 * evidence_available, failure_observed).
 *
 *   T(o|s,a) = (N(s,a,o) + β_o) / (Σ_u N(s,a,u) + Σ_u β_u),
 *   outcomes ∈ {verified_success, verified_failure, unknown}
 *
 * IRON RULE: predicted outcomes are NEVER counted. Only verified observations
 * enter the counts. `recordOutcome` additionally rejects any label outside the
 * verified outcome set at runtime; callers must pass every observation through
 * `assertObserved()` first, which throws unless the observation carries the
 * identity of the independent check that verified it. A same-model guess, a
 * predicted label, or a mock/symbolic result is not an observation.
 *
 * Continuation ranking: V_h(s) = max_a Σ_o T(o|s,a)[r(s,a,o) + γV_{h-1}(next)],
 * V_0 = 0, zero continuation at terminal states. Small-sample uncertainty
 * keeps the default workflow eligible via the β prior mass.
 *
 * Pure logic — persistence (SQLite) is another worker's module.
 */

import type { WorkflowArm } from './arms.ts';

/** Verified outcome labels. There is deliberately no "predicted_*" label. */
export type OutcomeLabel = 'verified_success' | 'verified_failure' | 'unknown';

export const OUTCOME_LABELS: readonly OutcomeLabel[] = [
  'verified_success',
  'verified_failure',
  'unknown',
];

/** Beta prior pseudocounts — uniform: small samples stay uncertain. */
export const BETA: Record<OutcomeLabel, number> = {
  verified_success: 1,
  verified_failure: 1,
  unknown: 1,
};

export const BETA_SUM: number = BETA.verified_success + BETA.verified_failure + BETA.unknown;

export interface OutcomeState {
  taskCategory: string;
  interpretationKnown: boolean;
  evidenceAvailable: boolean;
  failureObserved: boolean;
}

/** Canonical key for the state abstraction. */
export function outcomeKey(s: OutcomeState): string {
  const cat = (s.taskCategory ?? '').replace(/\|/g, '/');
  return `${cat}|i:${s.interpretationKnown ? 1 : 0}|e:${s.evidenceAvailable ? 1 : 0}|f:${s.failureObserved ? 1 : 0}`;
}

function countKey(s: OutcomeState, a: WorkflowArm): string {
  return `${outcomeKey(s)}::${a}`;
}

/**
 * Verified observation counts, keyed `${outcomeKey(s)}::${arm}` → per-outcome
 * counts. Only verified observations may be recorded here — see assertObserved.
 */
export type OutcomeCounts = Record<string, Partial<Record<OutcomeLabel, number>>>;

// ---------------------------------------------------------------------------
// The observed-vs-predicted gate.
// ---------------------------------------------------------------------------

/**
 * A verified observation: a label PLUS the identity of the independent check
 * that verified it (executable test, human review, source span — never a
 * same-model guess). The persistence layer stores these; the counts below
 * only ever aggregate labels that arrived via this shape.
 */
export interface ObservationRecord {
  label: OutcomeLabel;
  /** Id of the independent verification (check id / review id). Required. */
  verificationId: string;
  /** ISO timestamp of when the verification completed. */
  verifiedAt: string;
}

/**
 * Assert that a record is a genuine verified observation. Throws on:
 * - non-objects, missing/empty verificationId or verifiedAt,
 * - any label outside {verified_success, verified_failure, unknown} —
 *   including 'predicted_success' / 'predicted_failure' / 'simulated_*'.
 *
 * Call this BEFORE recordOutcome. Predicted outcomes must never reach the
 * counts; this is the runtime half of that discipline (the other half is the
 * OutcomeLabel type, which has no predicted members).
 */
export function assertObserved(rec: unknown): asserts rec is ObservationRecord {
  if (typeof rec !== 'object' || rec === null) {
    throw new Error('assertObserved: observation must be an object');
  }
  const { label, verificationId, verifiedAt } = rec as {
    label?: unknown;
    verificationId?: unknown;
    verifiedAt?: unknown;
  };
  if (!OUTCOME_LABELS.includes(label as OutcomeLabel)) {
    throw new Error(
      `assertObserved: '${String(label)}' is not a verified outcome — predicted outcomes are never counted`,
    );
  }
  if (typeof verificationId !== 'string' || verificationId.length === 0) {
    throw new Error(
      'assertObserved: verificationId is required (which independent check verified this?)',
    );
  }
  if (typeof verifiedAt !== 'string' || verifiedAt.length === 0) {
    throw new Error('assertObserved: verifiedAt timestamp is required');
  }
}

// ---------------------------------------------------------------------------
// Counting (pure).
// ---------------------------------------------------------------------------

/**
 * Record one VERIFIED observation. Immutable — returns new counts.
 * Throws on labels outside the verified outcome set, so a predicted label
 * can never slip into the counts even if assertObserved was skipped.
 */
export function recordOutcome(
  counts: OutcomeCounts,
  s: OutcomeState,
  a: WorkflowArm,
  o: OutcomeLabel,
): OutcomeCounts {
  if (!OUTCOME_LABELS.includes(o)) {
    throw new Error(
      `recordOutcome: '${String(o)}' is not a verified outcome — predicted outcomes are never counted`,
    );
  }
  const key = countKey(s, a);
  const entry = counts[key] ?? {};
  const prev = entry[o] ?? 0;
  if (!Number.isFinite(prev) || prev < 0) {
    throw new Error(`recordOutcome: corrupt count for ${key}/${o}`);
  }
  return { ...counts, [key]: { ...entry, [o]: prev + 1 } };
}

/**
 * T(o|s,a) = (N(s,a,o) + β_o) / (Σ_u N(s,a,u) + Σ_u β_u), with beta priors.
 * With no observations this is the uniform prior — small-sample uncertainty
 * keeps every arm (including the default workflow) eligible.
 */
export function outcomeDistribution(
  counts: OutcomeCounts,
  s: OutcomeState,
  a: WorkflowArm,
): Record<OutcomeLabel, number> {
  const entry = counts[countKey(s, a)] ?? {};
  let total = 0;
  for (const o of OUTCOME_LABELS) total += entry[o] ?? 0;
  const denom = total + BETA_SUM;
  const dist = {} as Record<OutcomeLabel, number>;
  for (const o of OUTCOME_LABELS) dist[o] = ((entry[o] ?? 0) + BETA[o]) / denom;
  return dist;
}

// ---------------------------------------------------------------------------
// Continuation ranking: V_h.
// ---------------------------------------------------------------------------

export interface ContinuationModel {
  /** Discount γ. */
  gamma: number;
  /** Horizon h ≥ 0. */
  horizon: number;
  /** Immediate reward r(s,a,o). */
  reward(s: OutcomeState, a: WorkflowArm, o: OutcomeLabel): number;
  /**
   * next(s,a,o), or null at terminal states (zero continuation — V stops).
   * Returning null is how "zero continuation at terminal states" is expressed.
   */
  next(s: OutcomeState, a: WorkflowArm, o: OutcomeLabel): OutcomeState | null;
}

export interface RankedArm {
  arm: WorkflowArm;
  /** Q_h(s,a) = Σ_o T(o|s,a)[r(s,a,o) + γV_{h-1}(next)] — a model judgment. */
  value: number;
}

/**
 * V_h(s) = max_a Σ_o T(o|s,a)[r(s,a,o) + γV_{h-1}(next(s,a,o))], V_0 = 0.
 * Terminal states (next() → null) contribute zero continuation.
 */
export function stateValue(
  counts: OutcomeCounts,
  s: OutcomeState,
  arms: WorkflowArm[],
  model: ContinuationModel,
  h: number,
): number {
  if (h <= 0 || arms.length === 0) return 0;
  let best = -Infinity;
  for (const a of arms) {
    const q = qValue(counts, s, arms, a, model, h);
    if (q > best) best = q;
  }
  return best === -Infinity ? 0 : best;
}

function qValue(
  counts: OutcomeCounts,
  s: OutcomeState,
  arms: WorkflowArm[],
  a: WorkflowArm,
  model: ContinuationModel,
  h: number,
): number {
  const T = outcomeDistribution(counts, s, a);
  let q = 0;
  for (const o of OUTCOME_LABELS) {
    const p = T[o];
    if (p === 0) continue;
    const ns = model.next(s, a, o);
    const future = ns === null ? 0 : model.gamma * stateValue(counts, ns, arms, model, h - 1);
    q += p * (model.reward(s, a, o) + future);
  }
  return q;
}

/**
 * Rank arms by Q_h(s,a), descending. Values are model judgments from learned
 * counts + prior — not measured success rates.
 */
export function rankContinuations(
  counts: OutcomeCounts,
  s: OutcomeState,
  arms: WorkflowArm[],
  model: ContinuationModel,
): RankedArm[] {
  const h = Math.max(0, Math.floor(model.horizon));
  const ranked = arms.map((arm) => ({
    arm,
    value: qValue(counts, s, arms, arm, model, h),
  }));
  ranked.sort((x, y) => y.value - x.value);
  return ranked;
}
