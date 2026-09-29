/** Run telemetry: timed segments, reason codes, and phase events (PR-07).
 *
 * The run's event record answers three questions without ever holding the
 * prompt, a tool argument, or a key:
 *
 *  1. How long did each part take? — one row per segment in `run_telemetry`:
 *     queue wait, preparation, MCP handshake, Jev decision, first provider
 *     byte, useful output. Names and durations only; the record function
 *     below takes no payload argument at all, so there is nowhere for a
 *     secret to enter. A test with red-team fixtures asserts this.
 *  2. Why did the run stop? — a machine-readable reason code on the runs row,
 *     stamped on every terminal/transition outcome (see RunReasonCode).
 *  3. Where is it now? — `data-run-phase` chunks on the run's event stream,
 *     consumed by the progress UI (lib/chat/pipeline-stage.ts). They carry
 *     the phase name and run id only.
 *
 * Given a run id, `runTimeline` returns the ordered segment sequence, so the
 * whole run reconstructs from submit to accepted result.
 */

/** The timed legs of a run, in lifecycle order. */
export const RUN_SEGMENTS = [
  'queue_wait',
  'preparation',
  'mcp_handshake',
  'jev_decision',
  'first_byte',
  'useful_output',
] as const;

export type RunSegment = (typeof RUN_SEGMENTS)[number];

/** Every terminal or transition outcome of a run, as a machine-readable code.
 * The human sentence still lives on `runs.error`; the code is for machines. */
export const RUN_REASON_CODES = [
  /** The run produced its answer. */
  'completed',
  /** The owner stopped it, or it never started before the stop arrived. */
  'cancelled',
  /** Paused on a tool approval the owner must answer. */
  'awaiting-approval',
  /** Paused on a question only the owner can answer. */
  'awaiting-answer',
  /** The loop ended with tool calls and no words. */
  'no-answer',
  /** The run's budget — not the provider — ended the run. */
  'budget-exhausted',
  /** The provider's first byte never arrived (free-tier queue bound). */
  'timeout',
  /** The provider refused or failed the call. */
  'provider-error',
  /** Our own code threw. */
  'internal-error',
  /** The owner denied a tool approval the run was waiting on. */
  'denied',
] as const;

export type RunReasonCode = (typeof RUN_REASON_CODES)[number];

/** Is this a reason code we know? Unknown codes — from an older or future
 * server, or garbage — must never drive client logic or the timeline. */
export function isRunReasonCode(value: unknown): value is RunReasonCode {
  return typeof value === 'string' && (RUN_REASON_CODES as readonly string[]).includes(value);
}

/** The narrated phases of a run, in the order they occur. The live phases
 * (up to `streaming`) map onto the progress UI's stages; the rest are
 * terminal/transition markers for the timeline. */
const RUN_PHASES = [
  'submitted',
  'preparing',
  'queued',
  'starting',
  'connecting-tools',
  'routing',
  'answering',
  'streaming',
  'awaiting-approval',
  'awaiting-answer',
  'done',
  'failed',
  'cancelled',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/** Is this a phase name we know? Unknown phase strings — from an older
 * server, a future server, or garbage — must never drive the progress UI. */
export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value);
}

export type TelemetrySegment = {
  runId: string;
  segment: RunSegment;
  durationMs: number;
  reasonCode: RunReasonCode | null;
  createdAt: string;
};

/** A `data-run-phase` chunk: the phase name and the run it belongs to, and
 * nothing else — except on a terminal or transition phase, which also carries
 * the run's reason code so the client need not read the row to say why it
 * stopped. Emitted on the run's event stream at every segment boundary;
 * same-id chunks replace, so the folded message carries the latest phase. */
export function phaseChunk(
  runId: string,
  phase: RunPhase,
  reasonCode?: RunReasonCode,
): {
  type: 'data-run-phase';
  id: 'run-phase';
  data: { phase: RunPhase; runId: string; reasonCode?: RunReasonCode };
} {
  return {
    type: 'data-run-phase',
    id: 'run-phase',
    data: reasonCode ? { phase, runId, reasonCode } : { phase, runId },
  };
}

/** Read the latest phase from a message's parts, or null when the run has not
 * emitted one (older runs, non-streamed clients). */
export function phaseFromParts(parts: readonly unknown[]): RunPhase | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as { type?: unknown; data?: unknown } | null;
    if (part && typeof part === 'object' && part.type === 'data-run-phase') {
      const phase = (part.data as { phase?: unknown } | undefined)?.phase;
      if (isRunPhase(phase)) return phase;
    }
  }
  return null;
}

/** Data parts that record how a turn was worked, never what it said. Kept
 * module-private beside usefulChunk so the bookkeeping set cannot drift from
 * the check. */
const TELEMETRY_BOOKKEEPING_PARTS = new Set(['data-memories', 'data-research', 'data-run-phase']);

/** Whether a streamed chunk is useful output rather than bookkeeping.
 *
 * Mirrors `answered()` in failure.ts at chunk granularity: text with words, a
 * file, or a data part that is itself an answer (a plan, a comparison) — but
 * not the parts that only record how the turn was worked. Chunks arrive as
 * `text-delta` (AI SDK), not `text`, so both shapes count.
 */
export function usefulChunk(chunk: unknown): boolean {
  const part = chunk as { type?: unknown; text?: unknown; delta?: unknown } | null;
  if (!part || typeof part !== 'object' || typeof part.type !== 'string') return false;
  if (part.type === 'text' || part.type === 'text-delta') {
    const words = part.type === 'text' ? part.text : part.delta;
    return typeof words === 'string' && words.trim().length > 0;
  }
  if (part.type === 'file') return true;
  return part.type.startsWith('data-') && !TELEMETRY_BOOKKEEPING_PARTS.has(part.type);
}

import { failureKind } from './failure.ts';

/**
 * The machine-readable reason for a thrown failure.
 *
 * A run that never got its provider's first byte is a timeout however the
 * error is worded; the free-tier bound in lib/runs/service.ts names its error
 * `FirstByteTimeout` for exactly this. Otherwise the same ours-vs-theirs shape
 * test lib/runs/failure.ts filters on: our storage faults and programming
 * errors are internal, everything else is the provider's.
 */
export function reasonCodeFor(error: unknown): RunReasonCode {
  if (error instanceof Error && error.name === 'FirstByteTimeout') return 'timeout';
  // Checked by name, not by import: budget-middleware's ledger pulls in half
  // the world, and this module must stay light enough for the client bundle.
  if (error instanceof Error && error.name === 'BudgetExhaustedError') return 'budget-exhausted';
  if (!(error instanceof Error)) return 'internal-error';
  return failureKind(error) === 'internal' ? 'internal-error' : 'provider-error';
}
