/** The comparison lane.
 *
 * Compare mode answers the same question twice: once through the full agent —
 * tools, research, review — and once directly, with no tools at all. Putting
 * them side by side is what makes the difference between the two workflows
 * visible, which is the whole point of the mode. It is not a second opinion
 * from a second model (though it can be); it is the same question without the
 * machinery.
 *
 * The baseline streams into the same durable log as the main answer, as
 * `data-compare` chunks sharing one part id. That matters for the same reason
 * the rest of the run is durable: a comparison that only existed in the tab
 * that started it would be gone on reload, and the whole value of the mode is
 * reading the two answers next to each other afterwards.
 */
import { convertToModelMessages, streamText, type LanguageModel, type UIMessage } from 'ai';
import { createLanguageModel, type ModelRequest } from './models.ts';

/** The one part id the lane writes to. Later chunks replace earlier ones, so
 * the transcript holds the finished comparison rather than a hundred fragments. */
export const COMPARE_PART_ID = 'compare';

export type CompareView = {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** The model that actually answered, which may differ from the one asked for. */
  model: string;
  text: string;
  /** Wall-clock time to the last token, so the two workflows can be compared on
   * cost as well as content. */
  latencyMs: number;
  /** Time to the first token: the number a person actually feels. */
  firstTextMs?: number;
  error?: string;
};

export type CompareOptions = {
  provider: ModelRequest;
  /** The system prompt, without the agent's tool instructions. */
  instructions: string;
  /** The conversation so far, as UI messages. */
  messages: UIMessage[];
  signal: AbortSignal;
  /** Writes one chunk into the run's stream. */
  write: (chunk: unknown) => void;
  /** Injected by the tests. */
  model?: LanguageModel;
  now?: () => number;
};

/**
 * Run the baseline answer and stream it as `data-compare` chunks.
 *
 * Never throws. The comparison is the second answer on the page: a provider
 * that refuses it, or a model that does not exist, should cost the lane and
 * nothing else — failing the run would take the main answer with it, which is
 * the answer the person actually asked for.
 */
export async function runComparison(options: CompareOptions): Promise<CompareView> {
  const now = options.now ?? (() => Date.now());
  const started = now();

  let view: CompareView = {
    status: 'running',
    model: options.provider.model,
    text: '',
    latencyMs: 0,
  };
  const publish = (next: Partial<CompareView>) => {
    view = { ...view, ...next, latencyMs: now() - started };
    options.write({ type: 'data-' + COMPARE_PART_ID, id: COMPARE_PART_ID, data: view });
  };

  publish({});

  // streamText reports a provider failure through onError and then simply ends
  // the text stream; it does not throw out of the iteration. Without this a
  // comparison that never started would be published as finished, with an empty
  // answer and no reason given.
  let failure: unknown;

  try {
    const result = streamText({
      model: options.model ?? createLanguageModel(options.provider),
      system: options.instructions,
      messages: await convertToModelMessages(options.messages),
      // No tools, deliberately and not as an oversight: a baseline that could
      // search the web would be measuring a different thing.
      abortSignal: options.signal,
      onError: ({ error }) => {
        failure = error;
      },
    });

    for await (const delta of result.textStream) {
      publish({
        text: view.text + delta,
        firstTextMs: view.firstTextMs ?? now() - started,
      });
    }
    // Checked first, and before the error: an aborted stream simply ends, with
    // no error to catch, so a comparison stopped halfway would otherwise be
    // published as finished — a partial answer with nothing saying it was cut
    // short.
    if (options.signal.aborted) {
      publish({ status: 'cancelled' });
      return view;
    }
    if (failure) throw failure;

    // The model that answered is only known once the response arrives, and it
    // is not always the one that was asked for: a provider may route elsewhere.
    // Worth reporting, and not worth failing the lane over if it is missing.
    let answered = view.model;
    try {
      answered = (await result.response).modelId || view.model;
    } catch {
      /* the text already arrived; which model produced it is a detail */
    }
    publish({ status: 'done', model: answered });
  } catch (error) {
    // A cancelled run is not a failed comparison, and saying "failed" for a
    // Stop the person pressed themselves would be a small lie in the transcript.
    if (options.signal.aborted) publish({ status: 'cancelled' });
    else
      publish({
        status: 'failed',
        error: error instanceof Error ? error.message : 'The comparison did not finish.',
      });
  }

  return view;
}
