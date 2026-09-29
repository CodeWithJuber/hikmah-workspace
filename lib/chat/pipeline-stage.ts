/** Which narrated pipeline stage the run is in, as an index into
 * HIKMAH_PIPELINE_STAGES (memory → tools → planning → writing).
 *
 * Pure and unit-tested: the mapping used to live inline in chat-view.tsx as a
 * heuristic over the run's activity label, and a drift between the narration
 * and the real stage boundaries reads as the product lying about what it is
 * doing. The contract: the index only ever moves forward through the stages
 * the caller actually renders, and an unknown state falls back to "planning"
 * (index 2) rather than claiming a stage it is not in.
 */
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
};

export function pipelineStageIndex(input: PipelineStageInput): number {
  if (!input.online) return 0;
  if (input.status === 'submitted') return 0;
  if (/^(Using|Running)/.test(input.activityLabel) || input.activityCompleted > 0) return 1;
  if (input.streamingText) return 3;
  return 2;
}
