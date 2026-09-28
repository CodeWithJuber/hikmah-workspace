/**
 * lib/workflow/arms.ts — Finite workflow arms of the v5 middle controller.
 *
 * Source of truth: docs/v5/research.md §"The middle controller: adaptive but
 * bounded" and phase3-spec §3.1. Semantics followed verbatim:
 *
 * - Five finite arms, each with a hard remote-call cap.
 * - Every call, retry, and exposed hidden-reasoning token counts toward the
 *   budget (enforced by lib/workflow/budget.ts).
 * - Terminal states are explicit; there are no silent stops.
 * - Cyclic or over-budget dependency plans are rejected BEFORE execution.
 * - Repair only fixes named defects, preserves the pre-repair candidate, and
 *   stops on budget exhaustion or no independently measured improvement.
 *
 * Pure logic only — no DB access, no provider calls.
 */

/** The five finite workflow arms. */
export type WorkflowArm = 'local' | 'direct' | 'verify-repair' | 'decompose' | 'explore-consensus';

/** Explicit terminal states. A run must end in exactly one of these. */
export type TerminalState =
  'cancelled' | 'timeout' | 'credential_failure' | 'budget_exhausted' | 'completed' | 'failed';

/** All terminal states, for runtime checks (e.g. honest UI surfacing). */
export const TERMINAL_STATES: readonly TerminalState[] = [
  'cancelled',
  'timeout',
  'credential_failure',
  'budget_exhausted',
  'completed',
  'failed',
];

/** All arms in canonical order (also the deterministic tie-break order). */
export const ARMS: readonly WorkflowArm[] = [
  'local',
  'direct',
  'verify-repair',
  'decompose',
  'explore-consensus',
];

/**
 * Hard remote-call caps per arm (v5 table, verbatim).
 * `local` executes a co-model frame or a promoted bounded procedure: zero
 * remote calls.
 */
export const ARM_CALL_CAP: Record<WorkflowArm, number> = {
  local: 0,
  direct: 1,
  'verify-repair': 3,
  decompose: 8,
  'explore-consensus': 6,
};

/** Decompose-specific structural limits from the v5 table. */
export const DECOMPOSE_MAX_LEAVES = 4;
export const DECOMPOSE_MAX_DEPTH = 2;

/**
 * Claim evidence statuses (v5 §"Evidence, critique, consensus, repair").
 * A working link proves neither entailment nor truth: a generated URL is only
 * a proposed source until retrieved, and only `externally_verified` claims
 * rest on an independent check.
 */
export type ClaimStatus =
  | 'unverified'
  | 'quoted_span_present'
  | 'model_assessed_support'
  | 'externally_verified'
  | 'contradicted';

/** One leaf of a typed dependency plan. `plannedCalls` counts its remote calls. */
export interface PlanLeaf {
  id: string;
  dependsOn: string[];
  plannedCalls: number;
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a typed dependency plan BEFORE execution.
 *
 * Rejects:
 * - empty plans (nothing to execute or merge),
 * - duplicate leaf ids,
 * - dependencies on unknown leaf ids (or on self),
 * - dependency cycles (dependent leaves must wait for validated outputs),
 * - over-budget plans (sum of planned calls > the arm's hard cap),
 * - decompose plans violating the 4-leaf / depth-2 structural limits.
 *
 * Returns { ok, errors } rather than throwing so the controller can surface
 * every defect at once. Pure function.
 */
export function validatePlan(arm: WorkflowArm, leaves: PlanLeaf[]): PlanValidation {
  const errors: string[] = [];

  if (leaves.length === 0) {
    errors.push('plan has no leaves');
    return { ok: false, errors };
  }

  const ids = new Set<string>();
  for (const leaf of leaves) {
    if (typeof leaf.id !== 'string' || leaf.id.length === 0) {
      errors.push('leaf with missing or empty id');
      continue;
    }
    if (ids.has(leaf.id)) errors.push(`duplicate leaf id: ${leaf.id}`);
    ids.add(leaf.id);
    if (!Number.isInteger(leaf.plannedCalls) || leaf.plannedCalls < 0) {
      errors.push(`leaf ${leaf.id}: plannedCalls must be a non-negative integer`);
    }
    if (!Array.isArray(leaf.dependsOn)) {
      errors.push(`leaf ${leaf.id}: dependsOn must be an array`);
    }
  }

  const byId = new Map<string, PlanLeaf>();
  for (const leaf of leaves) byId.set(leaf.id, leaf);

  for (const leaf of leaves) {
    for (const dep of leaf.dependsOn ?? []) {
      if (!byId.has(dep)) errors.push(`leaf ${leaf.id}: depends on unknown leaf ${dep}`);
      if (dep === leaf.id) errors.push(`leaf ${leaf.id}: depends on itself`);
    }
  }

  // Cycle detection: iterative DFS with colours (white / gray / black).
  const colour = new Map<string, number>(); // 0 = unvisited, 1 = in stack, 2 = done
  const stack: string[] = [];
  const visit = (id: string): void => {
    colour.set(id, 1);
    stack.push(id);
    const leaf = byId.get(id);
    if (leaf) {
      for (const dep of leaf.dependsOn ?? []) {
        if (!byId.has(dep)) continue; // already reported above
        const c = colour.get(dep) ?? 0;
        if (c === 1) {
          const cycle = [...stack.slice(stack.indexOf(dep)), dep].join(' -> ');
          errors.push(`dependency cycle: ${cycle}`);
          continue;
        }
        if (c === 0) visit(dep);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };
  for (const leaf of leaves) {
    if ((colour.get(leaf.id) ?? 0) === 0) visit(leaf.id);
  }

  // Over-budget check: sum of planned calls vs the arm's hard cap.
  const plannedTotal = leaves.reduce(
    (n, l) => n + (Number.isInteger(l.plannedCalls) && l.plannedCalls > 0 ? l.plannedCalls : 0),
    0,
  );
  const cap = ARM_CALL_CAP[arm];
  if (plannedTotal > cap) {
    errors.push(
      `plan needs ${plannedTotal} remote calls but arm '${arm}' is capped at ${cap}: rejected before execution`,
    );
  }

  // Decompose structural limits (v5 table: four leaves, depth two).
  if (arm === 'decompose') {
    if (leaves.length > DECOMPOSE_MAX_LEAVES) {
      errors.push(
        `decompose allows at most ${DECOMPOSE_MAX_LEAVES} leaves, plan has ${leaves.length}`,
      );
    }
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) return 1; // cycle already reported; avoid infinite recursion
      const cached = depth.get(id);
      if (cached !== undefined) return cached;
      const leaf = byId.get(id);
      let d = 1;
      if (leaf) {
        seen.add(id);
        for (const dep of leaf.dependsOn ?? []) {
          if (byId.has(dep)) d = Math.max(d, 1 + depthOf(dep, seen));
        }
        seen.delete(id);
      }
      depth.set(id, d);
      return d;
    };
    let maxDepth = 0;
    for (const leaf of leaves) maxDepth = Math.max(maxDepth, depthOf(leaf.id, new Set()));
    if (maxDepth > DECOMPOSE_MAX_DEPTH) {
      errors.push(
        `decompose allows dependency depth at most ${DECOMPOSE_MAX_DEPTH}, plan has depth ${maxDepth}`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Descriptive agreement: largest answer cluster / number of candidates.
 *
 * This is DESCRIPTIVE ONLY — it is not P(correct). Never present it as a
 * probability of correctness (v5: "agreement ... is descriptive, not
 * P(correct)"). Same-model lanes may share a blind spot, so clustered
 * agreement can be confidently wrong. For open prose, preserve substantive
 * disagreement instead of forcing a unanimous label.
 */
export function agreement(largestClusterSize: number, candidateCount: number): number {
  if (!Number.isFinite(largestClusterSize) || !Number.isFinite(candidateCount)) return 0;
  if (candidateCount <= 0) return 0; // no candidates: 0 agreement by convention
  const clamped = Math.min(Math.max(largestClusterSize, 0), candidateCount);
  return clamped / candidateCount;
}
