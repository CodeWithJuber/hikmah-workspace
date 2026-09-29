/**
 * lib/ai/budget-middleware.ts — Provider-call budget enforcement (PR-04).
 *
 * Wraps a LanguageModel so every dispatch goes through the run's durable
 * ledger (lib/workflow/ledger.ts):
 *
 * - BEFORE the provider is touched, `reserve()` must succeed. When the budget
 *   is exhausted the dispatch never happens: a BudgetExhaustedError is thrown
 *   instead. That is the explicit exhaustion signal — callers see a typed
 *   error naming the spent leg, never a silent hang or a generic failure.
 * - AFTER the dispatch, `settle()` charges the call with the ACTUAL usage.
 *   When the provider returns no usable usage the ledger settles
 *   conservatively (never zero).
 * - A dispatch that throws (provider error) or is aborted releases the
 *   reservation: the failed call is not charged. A retry is a new dispatch
 *   with its own reserve, so retries count like any other call.
 *
 * Because the middleware wraps the model object itself, every consumer of
 * that object shares one budget: the ToolLoopAgent's steps, every
 * deep-research lane (they receive the same model), and the closing step.
 * Concurrent lanes racing the last unit of budget serialize on the ledger's
 * transaction, so exactly one wins — no over-dispatch under races.
 */

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { RunBudgetLedger, SettleUsage, ExhaustionState } from '../workflow/ledger.ts';

/** Thrown instead of dispatching once the run's budget is exhausted.
 *
 * Typed so the run service can tell "the budget ran out" apart from every
 * other failure: the run is recorded with the explicit terminal state and a
 * sentence the owner can act on, not a generic error.
 */
export class BudgetExhaustedError extends Error {
  readonly name = 'BudgetExhaustedError';
  readonly runId: string;
  readonly terminalState: ExhaustionState;
  constructor(runId: string, terminalState: ExhaustionState, message: string) {
    super(message);
    this.runId = runId;
    this.terminalState = terminalState;
  }
}

function exhaustedError(
  runId: string,
  state: ExhaustionState,
  ledger: RunBudgetLedger,
): BudgetExhaustedError {
  const snap = ledger.snapshot();
  const message =
    state === 'timeout'
      ? `Run deadline exceeded after ${snap.spent.calls} provider call(s) ` +
        `(${snap.budget.deadlineMs} ms). No further calls will be dispatched for run ${runId}.`
      : `Run budget exhausted: ${snap.spent.calls}/${snap.budget.maxCalls} calls, ` +
        `${snap.spent.tokens}/${snap.budget.maxTokens} tokens used. ` +
        `No further provider calls will be dispatched for run ${runId}.`;
  return new BudgetExhaustedError(runId, state, message);
}

/** The usage shape this middleware reads: totals only. Accepts the V4 result
 * usage structurally so provider-specific extras never break the read. */
type UsageTotals =
  | {
      inputTokens?: { total?: unknown };
      outputTokens?: { total?: unknown };
    }
  | null
  | undefined;

/** Actual usage off a result, or null when the provider reported nothing
 * usable. inputTokens.total + outputTokens.total already includes exposed
 * hidden-reasoning tokens (they are part of the output total). */
function usageOf(usage: UsageTotals): SettleUsage | null {
  if (!usage) return null;
  const input = (usage as { inputTokens?: { total?: unknown } }).inputTokens?.total;
  const output = (usage as { outputTokens?: { total?: unknown } }).outputTokens?.total;
  const hasInput = typeof input === 'number' && Number.isFinite(input) && input >= 0;
  const hasOutput = typeof output === 'number' && Number.isFinite(output) && output >= 0;
  if (!hasInput && !hasOutput) return null;
  return {
    inputTokens: hasInput ? (input as number) : 0,
    outputTokens: hasOutput ? (output as number) : 0,
  };
}

/** A V4 stream part, structurally: only the fields this middleware reads. */
type StreamPart = {
  type?: string;
  usage?: UsageTotals;
  error?: unknown;
};

function budgetMiddleware(
  ledger: RunBudgetLedger,
  onExhausted?: (error: BudgetExhaustedError) => void,
): LanguageModelMiddleware {
  const runId = ledger.runId;
  const guard = (): void => {
    const reservation = ledger.reserve();
    if (!reservation.ok) {
      const error = exhaustedError(runId, reservation.state, ledger);
      onExhausted?.(error);
      throw error;
    }
  };
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      guard();
      try {
        const result = await doGenerate();
        ledger.settle(usageOf(result.usage));
        return result;
      } catch (error) {
        ledger.release();
        throw error;
      }
    },
    wrapStream: async ({ doStream }) => {
      guard();
      let result;
      try {
        result = await doStream();
      } catch (error) {
        ledger.release();
        throw error;
      }
      // The usage only arrives in the stream's finish part, so tap the
      // stream: settle on normal completion, release on error/cancel. A
      // manual ReadableStream (not pipeThrough): the standard Transformer
      // has no cancel hook, and a consumer that stops reading mid-stream is
      // an abort — the reservation must be released, and the provider call
      // cancelled rather than left running.
      let settled = false;
      let cancelled = false;
      let usage: SettleUsage | null = null;
      let source: ReadableStreamDefaultReader<unknown> | null = null;
      const tapped = new ReadableStream({
        async start(controller) {
          const reader = result.stream.getReader() as ReadableStreamDefaultReader<unknown>;
          source = reader;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done || cancelled) break;
              if (!settled) {
                const p = value as StreamPart;
                if (p?.type === 'finish' && p.usage) usage = usageOf(p.usage);
                if (p?.type === 'error') {
                  settled = true;
                  ledger.release();
                }
              }
              controller.enqueue(value);
            }
            if (!settled) {
              settled = true;
              // No finish part (provider closed early, usage withheld): the
              // ledger settles conservatively rather than assuming zero.
              ledger.settle(usage);
            }
            controller.close();
          } catch (error) {
            if (!settled) {
              settled = true;
              ledger.release();
            }
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        },
        cancel() {
          cancelled = true;
          if (!settled) {
            settled = true;
            ledger.release();
          }
          source?.cancel().catch(() => {
            /* the provider call is already dead to us */
          });
        },
      });
      return { ...result, stream: tapped as typeof result.stream };
    },
  };
}

/**
 * Wrap a language model with run-budget enforcement backed by `ledger`.
 *
 * The wrapped model is a drop-in LanguageModel: pass it wherever the original
 * went (agent, lanes, closing step) and every one of them draws from the same
 * durable budget.
 *
 * `onExhausted` fires when a dispatch is refused (before the throw): the
 * agent loop swallows step errors into an error chunk, so the run service
 * uses this to know the budget — not the provider — cut the run short.
 */
export function withRunBudget(
  model: LanguageModel,
  ledger: RunBudgetLedger,
  opts: { onExhausted?: (error: BudgetExhaustedError) => void } = {},
): LanguageModel {
  // wrapLanguageModel needs an instance; a bare model id is a caller bug.
  if (typeof model === 'string')
    throw new Error('withRunBudget: needs a model instance, not a model id');
  return wrapLanguageModel({ model, middleware: budgetMiddleware(ledger, opts.onExhausted) });
}
