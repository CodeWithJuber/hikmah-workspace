/**
 * lib/workflow/budget.ts — Per-run budget ledger (phase3-spec §3.1).
 *
 * Every provider call decrements the ledger: one call, one retry, and every
 * exposed hidden-reasoning token counts. One invalid-JSON retry consumes
 * budget like any other call. Exhaustion surfaces as the explicit terminal
 * state `budget_exhausted` (never as success); a passed deadline surfaces as
 * `timeout`.
 *
 * Pure logic — inject `now` for deterministic tests. No DB access.
 */

import type { TerminalState } from './arms.ts';

/** Per-run budget. All four legs are enforced. */
export interface Budget {
  maxCalls: number;
  maxTokens: number;
  maxCost: number;
  deadlineMs: number;
}

export interface BudgetUsage {
  calls: number;
  maxCalls: number;
  tokens: number;
  maxTokens: number;
  cost: number;
  maxCost: number;
  elapsedMs: number;
  deadlineMs: number;
}

export interface BudgetLedger {
  /**
   * Spend one provider call (a first attempt or a retry — both count), plus
   * any tokens/cost it consumed, including exposed hidden-reasoning tokens.
   * Returns the terminal state if this spend exhausted the budget or the
   * deadline passed, else null.
   */
  spendCall(tokens?: number, cost?: number): TerminalState | null;
  /**
   * Spend tokens without a call (e.g. exposed hidden-reasoning tokens billed
   * outside a call record). Returns the terminal state on exhaustion, else
   * null.
   */
  spendTokens(n: number): TerminalState | null;
  /** Current usage snapshot (for the honest budget bar in the UI). */
  usage(): BudgetUsage;
  /** Check exhaustion without spending. Deadline → 'timeout'. */
  isExhausted(): TerminalState | null;
}

export interface LedgerOptions {
  /** Ledger start time in ms. Defaults to now(). */
  startTimeMs?: number;
  /** Clock. Defaults to Date.now. Inject a fake clock in tests. */
  now?: () => number;
}

/**
 * Create a per-run ledger. Negative budget legs are clamped to 0 (a zero leg
 * means "nothing may be spent on it").
 */
export function createLedger(budget: Budget, opts: LedgerOptions = {}): BudgetLedger {
  const maxCalls = Math.max(0, Math.floor(budget.maxCalls));
  const maxTokens = Math.max(0, budget.maxTokens);
  const maxCost = Math.max(0, budget.maxCost);
  const deadlineMs = Math.max(0, budget.deadlineMs);
  const now = opts.now ?? Date.now;
  const start = opts.startTimeMs ?? now();

  let calls = 0;
  let tokens = 0;
  let cost = 0;

  const deadlineHit = (): boolean => now() - start >= deadlineMs;

  const exhausted = (): TerminalState | null => {
    if (deadlineHit()) return 'timeout';
    if (calls > maxCalls || tokens > maxTokens || cost > maxCost) return 'budget_exhausted';
    return null;
  };

  return {
    spendCall(callTokens = 0, callCost = 0): TerminalState | null {
      if (!Number.isFinite(callTokens) || callTokens < 0) {
        throw new Error('spendCall: tokens must be a non-negative finite number');
      }
      if (!Number.isFinite(callCost) || callCost < 0) {
        throw new Error('spendCall: cost must be a non-negative finite number');
      }
      if (deadlineHit()) return 'timeout';
      calls += 1;
      tokens += callTokens;
      cost += callCost;
      return exhausted();
    },

    spendTokens(n: number): TerminalState | null {
      if (!Number.isFinite(n) || n < 0) {
        throw new Error('spendTokens: n must be a non-negative finite number');
      }
      if (deadlineHit()) return 'timeout';
      tokens += n;
      return exhausted();
    },

    usage(): BudgetUsage {
      return {
        calls,
        maxCalls,
        tokens,
        maxTokens,
        cost,
        maxCost,
        elapsedMs: now() - start,
        deadlineMs,
      };
    },

    isExhausted(): TerminalState | null {
      return exhausted();
    },
  };
}
