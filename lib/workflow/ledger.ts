/**
 * lib/workflow/ledger.ts — Durable per-run budget reservations (PR-04).
 *
 * The stored budget (config.workflow.budget, stamped by lib/runs/enqueue.ts)
 * was never part of the execution path: this ledger puts it there. One ledger
 * per run, shared by every provider call and every research lane:
 *
 * - `reserve()` runs BEFORE dispatch, inside a BEGIN IMMEDIATE transaction.
 *   When capacity is unavailable it returns the explicit terminal state
 *   ('budget_exhausted' or 'timeout') and persists it on the row — the caller
 *   throws instead of dispatching, so no more calls go out once the budget
 *   is spent. Never a silent hang, never a generic error.
 * - `settle()` runs AFTER dispatch with the provider's ACTUAL usage. A
 *   provider that returns no usage is settled conservatively (a fraction of
 *   maxTokens, never zero): an unknown cost is not a free call.
 * - `release()` frees the reservation on failure/abort: the failed dispatch
 *   is not charged a call. A retry is a new dispatch with its own reserve.
 *
 * Durability: the settled spend and the budget live in the run_budget_ledger
 * row, so a resumed run (new ledger instance, same run id) sees the same
 * budget state, not a fresh one. The in-flight reservation count lives only
 * in memory: a crash evaporates in-flight reservations with the process, so a
 * resume can never inherit a phantom reservation — only the settled spend.
 *
 * Single-instance contract: one ledger instance per run per process. The run
 * worker drives a run exclusively (its `running` set), which upholds it.
 *
 * Pure-ish: inject `now` for deterministic tests. DB access is node:sqlite,
 * synchronous, following lib/runs/store.ts conventions.
 */

import type { SqliteHandle } from '../runs/store.ts';
import type { Budget } from './budget.ts';
import type { TerminalState } from './arms.ts';

/** The two exhaustion states a reserve can observe. */
export type ExhaustionState = 'budget_exhausted' | 'timeout';

/** What `reserve()` returns: either the green light or the explicit reason. */
export type ReserveResult = { ok: true } | { ok: false; state: ExhaustionState };

/** Actual usage reported back from a dispatch. Null/unknown settles
 * conservatively (see `unknownUsageFraction`); cost settles only when the
 * provider reports one — an unknowable cost is never invented. */
export interface SettleUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface SpentTally {
  calls: number;
  tokens: number;
  cost: number;
}

/** The persisted + in-flight budget state, for tests and the budget bar. */
export interface LedgerSnapshot {
  runId: string;
  budget: Budget;
  spent: SpentTally;
  /** In-flight dispatches: reserved but not yet settled or released. */
  reserved: number;
  state: 'active' | ExhaustionState;
  startedAtMs: number;
}

export interface LedgerOptions {
  /** Clock in ms. Defaults to Date.now. */
  now?: () => number;
  /**
   * Fraction of maxTokens charged when a dispatch returns no usable usage.
   * Defaults to 0.05 (Jev decision 2026-09-29, confidence 0.49 — weak advice,
   * adopted with the floor below as calibration: the charge scales with the
   * budget the operator approved, and can never be zero).
   */
  unknownUsageFraction?: number;
  /** Ledger start in ms, for tests. Defaults to now(). */
  startTimeMs?: number;
}

const DEFAULT_UNKNOWN_USAGE_FRACTION = 0.05;

function clampBudget(budget: Budget): Budget {
  return {
    maxCalls: Math.max(0, Math.floor(Number(budget.maxCalls) || 0)),
    maxTokens: Math.max(0, Number(budget.maxTokens) || 0),
    maxCost: Math.max(0, Number(budget.maxCost) || 0),
    deadlineMs: Math.max(0, Number(budget.deadlineMs) || 0),
  };
}

/** Guard the budget shape coming off the sealed run config: stored JSON is a
 * trust boundary even when we wrote it. */
export function asBudget(value: unknown): Budget | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  for (const leg of ['maxCalls', 'maxTokens', 'maxCost', 'deadlineMs'] as const) {
    if (typeof b[leg] !== 'number' || !Number.isFinite(b[leg] as number)) return null;
  }
  return clampBudget(b as unknown as Budget);
}

function parseTally(json: string): SpentTally {
  try {
    const v = JSON.parse(json) as Partial<SpentTally>;
    return {
      calls: Math.max(0, Number(v.calls) || 0),
      tokens: Math.max(0, Number(v.tokens) || 0),
      cost: Math.max(0, Number(v.cost) || 0),
    };
  } catch {
    return { calls: 0, tokens: 0, cost: 0 };
  }
}

export interface RunBudgetLedger {
  readonly runId: string;
  /** Reserve one provider call before dispatch. Returns the explicit
   * exhaustion state instead of dispatching when capacity is unavailable. */
  reserve(): ReserveResult;
  /** Settle a completed dispatch with its actual usage (or null when the
   * provider returned none — settled conservatively, never zero). */
  settle(usage: SettleUsage | null): void;
  /** Free the reservation after a failed or aborted dispatch: the failed
   * call is not charged. */
  release(): void;
  /** Current persisted + in-flight state. */
  snapshot(): LedgerSnapshot;
}

export function createRunBudgetLedger(
  db: SqliteHandle,
  runId: string,
  budget: Budget,
  opts: LedgerOptions = {},
): RunBudgetLedger {
  const clamped = clampBudget(budget);
  const now = opts.now ?? Date.now;
  const fraction =
    typeof opts.unknownUsageFraction === 'number' && opts.unknownUsageFraction >= 0
      ? opts.unknownUsageFraction
      : DEFAULT_UNKNOWN_USAGE_FRACTION;

  const statements = {
    get: db.prepare(
      'SELECT budget_json, spent_json, started_at_ms, state FROM run_budget_ledger WHERE run_id = ?',
    ),
    insert: db.prepare(
      `INSERT INTO run_budget_ledger (run_id, budget_json, spent_json, started_at_ms, state, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ),
    setState: db.prepare(`UPDATE run_budget_ledger SET state = ?, updated_at = ? WHERE run_id = ?`),
    setSpent: db.prepare(
      `UPDATE run_budget_ledger SET spent_json = ?, updated_at = ? WHERE run_id = ?`,
    ),
  };

  // A resumed run sees the SAME durable state, not a fresh one: the stored
  // budget wins over whatever the caller passed this time.
  const existing = statements.get.get(runId) as
    { budget_json: string; spent_json: string; started_at_ms: number; state: string } | undefined;
  let storedBudget = clamped;
  let spent: SpentTally = { calls: 0, tokens: 0, cost: 0 };
  let startedAtMs = opts.startTimeMs ?? now();
  let state: 'active' | ExhaustionState = 'active';
  if (existing) {
    const parsed = asBudget(JSON.parse(existing.budget_json as string));
    if (parsed) storedBudget = parsed;
    spent = parseTally(existing.spent_json as string);
    startedAtMs = Number(existing.started_at_ms) || startedAtMs;
    state =
      existing.state === 'budget_exhausted' || existing.state === 'timeout'
        ? (existing.state as ExhaustionState)
        : 'active';
  } else {
    statements.insert.run(
      runId,
      JSON.stringify(clamped),
      JSON.stringify(spent),
      startedAtMs,
      new Date(now()).toISOString(),
    );
  }

  // In-flight only: never persisted, so a crash cannot strand it.
  let reserved = 0;

  const deadlineHit = (): boolean => now() - startedAtMs >= storedBudget.deadlineMs;

  const exhaustion = (): ExhaustionState | null => {
    if (deadlineHit()) return 'timeout';
    if (spent.calls + reserved >= storedBudget.maxCalls) return 'budget_exhausted';
    if (spent.tokens >= storedBudget.maxTokens) return 'budget_exhausted';
    if (spent.cost >= storedBudget.maxCost) return 'budget_exhausted';
    return null;
  };

  const persistState = (s: ExhaustionState): void => {
    state = s;
    statements.setState.run(s, new Date(now()).toISOString(), runId);
  };

  const persistSpent = (): void => {
    statements.setSpent.run(JSON.stringify(spent), new Date(now()).toISOString(), runId);
  };

  /** Tokens for a dispatch with no usable usage: a fraction of the budget,
   * floored at 1 so a zero-token leg still trips on an unknowable call. */
  const conservativeTokens = (): number =>
    Math.max(1, Math.ceil(storedBudget.maxTokens * fraction));

  const usableTokens = (usage: SettleUsage | null): number | null => {
    if (!usage) return null;
    const parts = [usage.inputTokens, usage.outputTokens].filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    );
    const total = parts.reduce((a, b) => a + b, 0);
    // A usage object that reports nothing usable is an unknown cost, not a
    // free call: never settle zero on the word of a missing number.
    return total > 0 ? total : null;
  };

  return {
    runId,

    reserve(): ReserveResult {
      // BEGIN IMMEDIATE so two lanes racing in the same tick serialize on the
      // row; node:sqlite is synchronous, so no await can interleave between
      // the check and the in-memory increment below.
      db.exec('BEGIN IMMEDIATE');
      try {
        const hit = exhaustion();
        if (hit) {
          persistState(hit);
          db.exec('COMMIT');
          return { ok: false, state: hit };
        }
        reserved += 1;
        db.exec('COMMIT');
        return { ok: true };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw error;
      }
    },

    settle(usage: SettleUsage | null): void {
      reserved = Math.max(0, reserved - 1);
      spent.calls += 1;
      spent.tokens += usableTokens(usage) ?? conservativeTokens();
      if (
        usage &&
        typeof usage.cost === 'number' &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
      ) {
        spent.cost += usage.cost;
      }
      persistSpent();
    },

    release(): void {
      reserved = Math.max(0, reserved - 1);
    },

    snapshot(): LedgerSnapshot {
      return {
        runId,
        budget: { ...storedBudget },
        spent: { ...spent },
        reserved,
        state,
        startedAtMs,
      };
    },
  };
}

/** Re-export for callers that reach for the exhaustion vocabulary here. */
export type { TerminalState };
