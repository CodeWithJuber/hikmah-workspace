/** Which narrated pipeline stage the run is in, as an index into
 * HIKMAH_PIPELINE_STAGES (memory → tools → planning → writing).
 *
 * Pure and unit-tested: the mapping used to live inline in chat-view.tsx as a
 * heuristic over the run's activity label, and a drift between the narration
 * and the real stage boundaries reads as the product lying about what it is
 * doing. The contract: the index only ever moves forward through the stages
 * the caller actually renders, and an unknown state falls back to "planning"
 * (index 2) rather than claiming a stage it is not in.
 *
 * When the run has emitted a real `data-run-phase` part (PR-07), that phase
 * overrides the heuristic: the narration follows the actual segment
 * boundaries — queued, connecting tools, routing, answering, streaming —
 * instead of guessing from the activity label. The phase mapping is
 * monotonic, so the override keeps the never-move-backward contract.
 */
import type { RunPhase } from '../runs/telemetry.ts';

export type PipelineStageInput = {
  /** False when the browser is offline — the run cannot be doing anything. */
  online: boolean;
  /** The useChat status of the current run. */
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** The activity label of the last message (e.g. "Using web_search"). */
  activityLabel: string;
  /** How many tool calls the last message has completed. */
  activityCompleted: number;
  /** Whether any answer text has arrived yet. */
  streamingText: boolean;
  /** The run's real phase, from its latest `data-run-phase` part, or null
   * when the run has not emitted one (older runs, non-streamed clients). */
  phase?: RunPhase | null;
};

/** Which narrated stage a real run phase maps to. The transitions and
 * terminal states map to null: the narration is not shown then (the run is
 * paused or done), so those fall back to the heuristic. */
const PHASE_STAGE: Record<RunPhase, number | null> = {
  submitted: 0,
  preparing: 0,
  queued: 0,
  starting: 0,
  'connecting-tools': 1,
  routing: 2,
  answering: 2,
  streaming: 3,
  'awaiting-approval': null,
  'awaiting-answer': null,
  done: null,
  failed: null,
  cancelled: null,
};

export function pipelineStageIndex(input: PipelineStageInput): number {
  if (input.phase) {
    const stage = PHASE_STAGE[input.phase];
    if (stage !== null) return stage;
  }
  if (!input.online) return 0;
  if (input.status === 'submitted') return 0;
  if (/^(Using|Running)/.test(input.activityLabel) || input.activityCompleted > 0) return 1;
  if (input.streamingText) return 3;
  return 2;
}
