/**
 * lib/workflow/dispatch.ts — Workflow arm dispatch service (PR-10).
 *
 * The contract (accepted review 08-IMPLEMENTATION-BACKLOG.md, PR-10):
 * every selectable arm genuinely executes its declared steps and call cap —
 * no phantom options, no arm silently behaving as direct. Dispatch goes
 * through the PR-04 budget reservations: every provider call reserves before
 * it goes out and settles (or releases, on failure) after.
 *
 * Executed behavior per arm (docs/v5/research.md §"The middle controller",
 * verbatim semantics):
 * - local: co-model frame or promoted bounded procedure. Zero remote calls.
 * - direct: one selected-model answer. One call.
 * - verify-repair: draft, independent check records, targeted repair(s) of
 *   NAMED defects only. Stops on the call cap, on budget exhaustion, or when
 *   no independently measured improvement occurs. The pre-repair candidate is
 *   preserved (revision can damage a correct answer). Three calls max.
 * - decompose: the typed dependency plan is validated BEFORE execution
 *   (cyclic / over-budget / malformed plans are rejected with the provider
 *   never called); leaves execute in dependency order; outputs merge; an
 *   optional check + one repair when a verifier is wired. Eight calls max.
 * - explore-consensus: three independently prompted candidates, compare
 *   (cluster + agreement, descriptive — never P(correct)), synthesize, one
 *   optional repair. Six calls max. Substantive disagreement is preserved in
 *   the result, never forced into unanimity.
 *
 * Independence of checks: `verify` must be an INDEPENDENT check (executable
 * test, human review, source span — never the generator grading itself; v5:
 * "the same generator may propose the critique, but cannot manufacture an
 * external check's success status"). The worker wires the real check; tests
 * inject fakes. A verifier that throws fails the run — a broken check never
 * silently passes.
 *
 * Injection boundary: this module owns arm semantics, cap enforcement, and
 * the reserve/settle discipline. Provider I/O (`callProvider`), independent
 * checks (`verify`), and local execution (`localExecute`) are injected, so
 * the module stays testable without network or model access.
 */

import {
  ARMS,
  ARM_CALL_CAP,
  agreement,
  validatePlan,
  type PlanLeaf,
  type TerminalState,
  type WorkflowArm,
} from './arms.ts';
import type { RunBudgetLedger, SettleUsage } from './ledger.ts';

/** Every selectable arm has an executor. No phantom options. */
export const DISPATCHABLE_ARMS: readonly WorkflowArm[] = ARMS;

/** One provider call, injected. The worker wires the real model. */
export interface ProviderRequest {
  prompt: string;
  /** Why this call exists — visible in tests and the honest cost ledger. */
  purpose: 'generate' | 'repair' | 'leaf' | 'candidate' | 'synthesize';
  context?: unknown;
}

export interface ProviderResponse {
  text: string;
  /** Actual usage; null/unknown settles conservatively via the PR-04 ledger. */
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number } | null;
}

export type ProviderCall = (request: ProviderRequest) => Promise<ProviderResponse>;

/**
 * One independent check record: WHICH check ran and the NAMED defects it
 * found. Empty defects = clean.
 */
export interface CheckRecord {
  /** Identity of the independent check (test id, review id, source span). */
  checkId: string;
  defects: string[];
}

export interface VerifyContext {
  arm: WorkflowArm;
  /** 'draft' | 'repair' | 'merged' | 'candidate' | 'synthesis' */
  stage: string;
}

/**
 * Independent verifier. Must NOT be the generator grading its own output.
 * May be sync or async.
 */
export type Verifier = (
  candidate: string,
  ctx: VerifyContext,
) => CheckRecord | Promise<CheckRecord>;

/** Local executor for the `local` arm (co-model frame / promoted procedure). */
export type LocalExecute = (prompt: string) => string | Promise<string>;

export interface DispatchHooks {
  /** Required for every remote arm. */
  callProvider?: ProviderCall;
  /** Required for verify-repair; enables check+repair for decompose/explore-consensus. */
  verify?: Verifier;
  /** Required for local. */
  localExecute?: LocalExecute;
  /** Required for decompose: the typed dependency plan. */
  plan?: PlanLeaf[];
  /** Required for decompose: build one leaf's prompt from validated dep outputs. */
  leafPrompt?: (leaf: PlanLeaf, depOutputs: Record<string, string[]>) => string;
  /** Required for decompose: merge per-leaf outputs into the final artifact. */
  mergeLeaves?: (outputs: Record<string, string[]>) => string;
  /** explore-consensus: build candidate i's prompt (isolated context). */
  candidatePrompt?: (index: number, prompt: string) => string;
  /** explore-consensus: cluster key for agreement (default: exact text). */
  clusterKey?: (candidate: string) => string;
  /** explore-consensus: build the synthesis prompt from candidates + checks. */
  synthesizePrompt?: (candidates: string[], checks: CheckRecord[]) => string;
  /** explore-consensus/decompose/verify-repair: build a repair prompt. */
  repairPrompt?: (candidate: string, defects: string[]) => string;
  /** Classify a provider error as a credential failure. */
  isCredentialError?: (err: unknown) => boolean;
}

export interface DispatchOptions {
  arm: WorkflowArm;
  prompt: string;
  /** The PR-04 run budget ledger, shared by every call in the run. */
  ledger: RunBudgetLedger;
  hooks: DispatchHooks;
}

export interface DispatchResult {
  arm: WorkflowArm;
  /** Exactly one explicit terminal state — never a silent stop. */
  terminal: TerminalState;
  /** Provider calls made by this dispatch (always ≤ the arm's cap). */
  calls: number;
  /** The final artifact, when the arm produced one. */
  result?: string;
  /** verify-repair: the draft before any repair (preserved, never overwritten). */
  preRepairResult?: string;
  /** explore-consensus: every candidate — disagreement preserved. */
  candidates?: string[];
  /** explore-consensus: largest-cluster/candidates — DESCRIPTIVE, not P(correct). */
  agreement?: number;
  /** Every independent check record, in run order. */
  checks: CheckRecord[];
  /** Named defects remaining on the final artifact (empty = clean). */
  defects: string[];
  /** Internal detail for the failed/budget terminal; the caller maps it to a safe message. */
  error?: string;
}

const defaultRepairPrompt = (candidate: string, defects: string[]): string =>
  `The previous answer has these defects:\n${defects.map((d) => `- ${d}`).join('\n')}\n` +
  `Fix ONLY the named defects. Preserve everything else.\n\nPrevious answer:\n${candidate}`;

const defaultCandidatePrompt = (index: number, prompt: string): string =>
  `Attempt ${index + 1} (answer independently, do not reference other attempts):\n${prompt}`;

const defaultSynthesizePrompt = (candidates: string[], checks: CheckRecord[]): string => {
  const listed = candidates.map((c, i) => `Candidate ${i + 1}:\n${c}`).join('\n\n');
  const findings = checks
    .map((c) => `${c.checkId}: ${c.defects.length === 0 ? 'clean' : c.defects.join('; ')}`)
    .join('\n');
  return (
    `Synthesize the candidates below into one answer. ` +
    `Where they substantively disagree and there is no canonical answer, preserve the disagreement ` +
    `instead of forcing a single claim.\n\n${listed}\n\nIndependent check findings:\n${findings}`
  );
};

function defaultIsCredentialError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === 'credential_failure') return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /credential|unauthorized|unauthenticated|\b401\b|\b403\b|api[_ -]?key|forbidden/i.test(
    msg,
  );
}

function usageOf(response: ProviderResponse): SettleUsage | null {
  const u = response.usage;
  if (!u || typeof u !== 'object') return null;
  const out: SettleUsage = {};
  if (typeof u.inputTokens === 'number') out.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === 'number') out.outputTokens = u.outputTokens;
  if (typeof u.cost === 'number') out.cost = u.cost;
  return out;
}

type CallOutcome =
  { ok: true; response: ProviderResponse } | { ok: false; terminal: TerminalState; error: string };

interface CallState {
  arm: WorkflowArm;
  cap: number;
  calls: number;
  ledger: RunBudgetLedger;
  callProvider: ProviderCall;
  isCredentialError: (err: unknown) => boolean;
}

/**
 * The one primitive every provider call goes through:
 * 1. the arm's hard call cap (even if the ledger budget is larger),
 * 2. PR-04 reserve() BEFORE dispatch — exhaustion returns the explicit
 *    terminal state and nothing goes out,
 * 3. settle() with actual usage after, release() when the call fails
 *    (a failed dispatch is not charged).
 */
async function guardedCall(state: CallState, request: ProviderRequest): Promise<CallOutcome> {
  if (state.calls >= state.cap) {
    return {
      ok: false,
      terminal: 'budget_exhausted',
      error: `arm '${state.arm}' call cap (${state.cap}) hit — refusing further calls`,
    };
  }
  const reserved = state.ledger.reserve();
  if (!reserved.ok) {
    return {
      ok: false,
      terminal: reserved.state,
      error: `budget ${reserved.state === 'timeout' ? 'deadline hit' : 'exhausted'} before '${request.purpose}' call`,
    };
  }
  try {
    const response = await state.callProvider(request);
    state.ledger.settle(usageOf(response));
    state.calls += 1;
    return { ok: true, response };
  } catch (err) {
    state.ledger.release();
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      terminal: state.isCredentialError(err) ? 'credential_failure' : 'failed',
      error: `provider call ('${request.purpose}') failed: ${message}`,
    };
  }
}

/** Required injections per arm, checked BEFORE any provider call. */
function missingHook(arm: WorkflowArm, hooks: DispatchHooks): string | null {
  switch (arm) {
    case 'local':
      return hooks.localExecute ? null : 'localExecute';
    case 'direct':
      return hooks.callProvider ? null : 'callProvider';
    case 'verify-repair':
      if (!hooks.callProvider) return 'callProvider';
      // The verifier is what makes this arm verify-repair instead of direct.
      if (!hooks.verify) return 'verify (an independent verifier)';
      return null;
    case 'decompose':
      if (!hooks.callProvider) return 'callProvider';
      if (!hooks.plan) return 'plan (a typed dependency plan)';
      if (!hooks.leafPrompt) return 'leafPrompt';
      if (!hooks.mergeLeaves) return 'mergeLeaves';
      return null;
    case 'explore-consensus':
      return hooks.callProvider ? null : 'callProvider';
  }
}

/** Run one independent check. A throwing check fails the run — never a silent pass. */
async function runCheck(
  verify: Verifier,
  candidate: string,
  ctx: VerifyContext,
): Promise<{ ok: true; record: CheckRecord } | { ok: false; error: string }> {
  try {
    const record = await verify(candidate, ctx);
    if (!record || typeof record !== 'object' || !Array.isArray(record.defects)) {
      return { ok: false, error: 'verifier returned a malformed check record' };
    }
    return { ok: true, record };
  } catch (err) {
    return {
      ok: false,
      error: `independent check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Arm executors.
// ---------------------------------------------------------------------------

async function runLocal(prompt: string, hooks: DispatchHooks): Promise<DispatchResult> {
  const execute = hooks.localExecute as LocalExecute;
  try {
    const result = await execute(prompt);
    return {
      arm: 'local',
      terminal: 'completed',
      calls: 0,
      result: String(result),
      checks: [],
      defects: [],
    };
  } catch (err) {
    return {
      arm: 'local',
      terminal: 'failed',
      calls: 0,
      checks: [],
      defects: [],
      error: `local execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runDirect(prompt: string, state: CallState): Promise<DispatchResult> {
  const outcome = await guardedCall(state, { prompt, purpose: 'generate' });
  if (!outcome.ok) {
    return {
      arm: 'direct',
      terminal: outcome.terminal,
      calls: state.calls,
      checks: [],
      defects: [],
      error: outcome.error,
    };
  }
  return {
    arm: 'direct',
    terminal: 'completed',
    calls: state.calls,
    result: outcome.response.text,
    checks: [],
    defects: [],
  };
}

async function runVerifyRepair(
  prompt: string,
  state: CallState,
  verify: Verifier,
  hooks: DispatchHooks,
): Promise<DispatchResult> {
  const repairPrompt = hooks.repairPrompt ?? defaultRepairPrompt;
  const checks: CheckRecord[] = [];

  const draftOutcome = await guardedCall(state, { prompt, purpose: 'generate' });
  if (!draftOutcome.ok) {
    return {
      arm: 'verify-repair',
      terminal: draftOutcome.terminal,
      calls: state.calls,
      checks,
      defects: [],
      error: draftOutcome.error,
    };
  }
  const preRepairResult = draftOutcome.response.text;

  let candidate = preRepairResult;
  const draftCheck = await runCheck(verify, candidate, { arm: 'verify-repair', stage: 'draft' });
  if (!draftCheck.ok) {
    return {
      arm: 'verify-repair',
      terminal: 'failed',
      calls: state.calls,
      preRepairResult,
      checks,
      defects: [],
      error: draftCheck.error,
    };
  }
  checks.push(draftCheck.record);

  // Best candidate by INDEPENDENTLY MEASURED defect count. Starts at the draft.
  let best = candidate;
  let bestDefects = draftCheck.record.defects;
  let currentDefects = draftCheck.record.defects;

  // Targeted repairs of named defects only. Stops when: clean, the arm's call
  // cap is hit, the budget is exhausted mid-arm, or a repair shows no
  // independently measured improvement over the best so far.
  while (currentDefects.length > 0 && state.calls < state.cap) {
    const repairOutcome = await guardedCall(state, {
      prompt: repairPrompt(candidate, currentDefects),
      purpose: 'repair',
      context: { defects: currentDefects },
    });
    if (!repairOutcome.ok) {
      return {
        arm: 'verify-repair',
        terminal: repairOutcome.terminal,
        calls: state.calls,
        result: best,
        preRepairResult,
        checks,
        defects: bestDefects,
        error: repairOutcome.error,
      };
    }
    candidate = repairOutcome.response.text;
    const recheck = await runCheck(verify, candidate, { arm: 'verify-repair', stage: 'repair' });
    if (!recheck.ok) {
      return {
        arm: 'verify-repair',
        terminal: 'failed',
        calls: state.calls,
        result: best,
        preRepairResult,
        checks,
        defects: bestDefects,
        error: recheck.error,
      };
    }
    checks.push(recheck.record);
    currentDefects = recheck.record.defects;
    if (currentDefects.length < bestDefects.length) {
      best = candidate;
      bestDefects = currentDefects;
    } else {
      break; // no independently measured improvement — keep the best, stop
    }
  }

  return {
    arm: 'verify-repair',
    terminal: 'completed',
    calls: state.calls,
    result: best,
    preRepairResult,
    checks,
    defects: bestDefects,
  };
}

/** Dependency-first leaf order (DFS post-order). The plan is validated acyclic first. */
function topoOrder(plan: PlanLeaf[]): PlanLeaf[] {
  const byId = new Map(plan.map((l) => [l.id, l]));
  const visited = new Set<string>();
  const order: PlanLeaf[] = [];
  const visit = (leaf: PlanLeaf): void => {
    if (visited.has(leaf.id)) return;
    visited.add(leaf.id);
    for (const dep of leaf.dependsOn ?? []) {
      const depLeaf = byId.get(dep);
      if (depLeaf) visit(depLeaf);
    }
    order.push(leaf);
  };
  for (const leaf of plan) visit(leaf);
  return order;
}

async function runDecompose(
  state: CallState,
  verify: Verifier | undefined,
  hooks: DispatchHooks,
): Promise<DispatchResult> {
  const arm = 'decompose' as const;
  const plan = hooks.plan as PlanLeaf[];
  const leafPrompt = hooks.leafPrompt as (
    leaf: PlanLeaf,
    depOutputs: Record<string, string[]>,
  ) => string;
  const mergeLeaves = hooks.mergeLeaves as (outputs: Record<string, string[]>) => string;
  const repairPrompt = hooks.repairPrompt ?? defaultRepairPrompt;

  // The plan is validated BEFORE execution: cyclic, over-budget, or malformed
  // plans are rejected with the provider never called.
  const validation = validatePlan(arm, plan);
  if (!validation.ok) {
    return {
      arm,
      terminal: 'failed',
      calls: 0,
      checks: [],
      defects: [],
      error: `invalid dependency plan: ${validation.errors.join('; ')}`,
    };
  }

  const outputs: Record<string, string[]> = {};
  for (const leaf of topoOrder(plan)) {
    const depOutputs: Record<string, string[]> = {};
    for (const dep of leaf.dependsOn ?? []) depOutputs[dep] = outputs[dep] ?? [];
    const leafTexts: string[] = [];
    for (let i = 0; i < leaf.plannedCalls; i++) {
      const outcome = await guardedCall(state, {
        prompt: leafPrompt(leaf, depOutputs),
        purpose: 'leaf',
        context: { leafId: leaf.id, callIndex: i },
      });
      if (!outcome.ok) {
        return {
          arm,
          terminal: outcome.terminal,
          calls: state.calls,
          checks: [],
          defects: [],
          error: outcome.error,
        };
      }
      leafTexts.push(outcome.response.text);
    }
    outputs[leaf.id] = leafTexts;
  }

  const checks: CheckRecord[] = [];
  let merged = mergeLeaves(outputs);
  let defects: string[] = [];

  // "merge, check, optional repair": one targeted repair when a verifier is
  // wired and the merged output is defective and the cap allows it.
  if (verify) {
    const check = await runCheck(verify, merged, { arm, stage: 'merged' });
    if (!check.ok) {
      return {
        arm,
        terminal: 'failed',
        calls: state.calls,
        result: merged,
        checks,
        defects,
        error: check.error,
      };
    }
    checks.push(check.record);
    defects = check.record.defects;
    if (defects.length > 0 && state.calls < state.cap) {
      const repairOutcome = await guardedCall(state, {
        prompt: repairPrompt(merged, defects),
        purpose: 'repair',
        context: { defects },
      });
      if (!repairOutcome.ok) {
        return {
          arm,
          terminal: repairOutcome.terminal,
          calls: state.calls,
          result: merged,
          checks,
          defects,
          error: repairOutcome.error,
        };
      }
      const repaired = repairOutcome.response.text;
      const recheck = await runCheck(verify, repaired, { arm, stage: 'repair' });
      if (!recheck.ok) {
        return {
          arm,
          terminal: 'failed',
          calls: state.calls,
          result: merged,
          checks,
          defects,
          error: recheck.error,
        };
      }
      checks.push(recheck.record);
      if (recheck.record.defects.length < defects.length) {
        merged = repaired;
        defects = recheck.record.defects;
      }
    }
  }

  return { arm, terminal: 'completed', calls: state.calls, result: merged, checks, defects };
}

async function runExploreConsensus(
  prompt: string,
  state: CallState,
  verify: Verifier | undefined,
  hooks: DispatchHooks,
): Promise<DispatchResult> {
  const arm = 'explore-consensus' as const;
  const candidatePrompt = hooks.candidatePrompt ?? defaultCandidatePrompt;
  const clusterKey = hooks.clusterKey ?? ((c: string): string => c);
  const synthesizePrompt = hooks.synthesizePrompt ?? defaultSynthesizePrompt;
  const repairPrompt = hooks.repairPrompt ?? defaultRepairPrompt;

  // Three independently prompted candidates (isolated calls, no shared context).
  const candidates: string[] = [];
  for (let i = 0; i < 3; i++) {
    const outcome = await guardedCall(state, {
      prompt: candidatePrompt(i, prompt),
      purpose: 'candidate',
      context: { index: i },
    });
    if (!outcome.ok) {
      return {
        arm,
        terminal: outcome.terminal,
        calls: state.calls,
        candidates,
        checks: [],
        defects: [],
        error: outcome.error,
      };
    }
    candidates.push(outcome.response.text);
  }

  // Compare: independent checks per candidate when a verifier is wired.
  const checks: CheckRecord[] = [];
  if (verify) {
    for (let i = 0; i < candidates.length; i++) {
      const check = await runCheck(verify, candidates[i], { arm, stage: 'candidate' });
      if (!check.ok) {
        return {
          arm,
          terminal: 'failed',
          calls: state.calls,
          candidates,
          checks,
          defects: [],
          error: check.error,
        };
      }
      checks.push(check.record);
    }
  }

  // agreement() is DESCRIPTIVE (largest cluster / candidates) — never P(correct).
  const clusters = new Map<string, number>();
  for (const c of candidates) clusters.set(clusterKey(c), (clusters.get(clusterKey(c)) ?? 0) + 1);
  const largestCluster = Math.max(...clusters.values());
  const descriptiveAgreement = agreement(largestCluster, candidates.length);

  const synthOutcome = await guardedCall(state, {
    prompt: synthesizePrompt(candidates, checks),
    purpose: 'synthesize',
  });
  if (!synthOutcome.ok) {
    return {
      arm,
      terminal: synthOutcome.terminal,
      calls: state.calls,
      candidates,
      agreement: descriptiveAgreement,
      checks,
      defects: [],
      error: synthOutcome.error,
    };
  }
  let result = synthOutcome.response.text;
  let defects: string[] = [];

  // Optional repair: one targeted attempt when the synthesis is defective.
  if (verify) {
    const check = await runCheck(verify, result, { arm, stage: 'synthesis' });
    if (!check.ok) {
      return {
        arm,
        terminal: 'failed',
        calls: state.calls,
        result,
        candidates,
        agreement: descriptiveAgreement,
        checks,
        defects,
        error: check.error,
      };
    }
    checks.push(check.record);
    defects = check.record.defects;
    if (defects.length > 0 && state.calls < state.cap) {
      const repairOutcome = await guardedCall(state, {
        prompt: repairPrompt(result, defects),
        purpose: 'repair',
        context: { defects },
      });
      if (!repairOutcome.ok) {
        return {
          arm,
          terminal: repairOutcome.terminal,
          calls: state.calls,
          result,
          candidates,
          agreement: descriptiveAgreement,
          checks,
          defects,
          error: repairOutcome.error,
        };
      }
      const repaired = repairOutcome.response.text;
      const recheck = await runCheck(verify, repaired, { arm, stage: 'repair' });
      if (!recheck.ok) {
        return {
          arm,
          terminal: 'failed',
          calls: state.calls,
          result,
          candidates,
          agreement: descriptiveAgreement,
          checks,
          defects,
          error: recheck.error,
        };
      }
      checks.push(recheck.record);
      if (recheck.record.defects.length < defects.length) {
        result = repaired;
        defects = recheck.record.defects;
      }
    }
  }

  return {
    arm,
    terminal: 'completed',
    calls: state.calls,
    result,
    candidates,
    agreement: descriptiveAgreement,
    checks,
    defects,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Dispatch one workflow arm: execute its declared steps against its hard call
 * cap, routing every provider call through the PR-04 budget ledger
 * (reserve → dispatch → settle, release on failure).
 *
 * Unknown arms throw (a programming error, not a run outcome). A missing
 * required injection returns terminal 'failed' BEFORE any provider call —
 * an arm never silently degrades into another arm's behavior.
 */
export async function dispatchArm(opts: DispatchOptions): Promise<DispatchResult> {
  const { arm, prompt, ledger, hooks } = opts;
  if (!ARMS.includes(arm)) {
    throw new Error(`dispatchArm: unknown workflow arm '${String(arm)}'`);
  }

  const missing = missingHook(arm, hooks);
  if (missing) {
    return {
      arm,
      terminal: 'failed',
      calls: 0,
      checks: [],
      defects: [],
      error:
        `arm '${arm}' requires '${missing}' but it was not injected — ` +
        `refusing to run degraded (no arm may silently behave as direct)`,
    };
  }

  if (arm === 'local') {
    return runLocal(prompt, hooks);
  }

  const state: CallState = {
    arm,
    cap: ARM_CALL_CAP[arm],
    calls: 0,
    ledger,
    callProvider: hooks.callProvider as ProviderCall,
    isCredentialError: hooks.isCredentialError ?? defaultIsCredentialError,
  };
  const verify = hooks.verify;

  switch (arm) {
    case 'direct':
      return runDirect(prompt, state);
    case 'verify-repair':
      return runVerifyRepair(prompt, state, verify as Verifier, hooks);
    case 'decompose':
      return runDecompose(state, verify, hooks);
    case 'explore-consensus':
      return runExploreConsensus(prompt, state, verify, hooks);
  }
}
