/** One more step, with the tools withheld, before a run is declared silent.
 *
 * Small free models call a tool, read its result, and then emit nothing — the
 * loop ends because there is no further tool call, and the transcript shows
 * the working and no answer. That reached the owner as "the model stopped
 * without writing an answer", with the tokens already spent. Reported from
 * the phone with the card on screen and 86,336 tokens on the receipt.
 *
 * This gives the turn one more request, not twelve: the same conversation and
 * the same tool results, with tool calling switched off and an instruction to
 * write the answer now. Only when the stream ended with no words, no file, no
 * data part, and nothing waiting on a person. If the extra step is silent too,
 * or fails, the stream ends as it would have and the run's own rule says so.
 *
 * Pure: takes a chunk stream and returns one, so it can be tested with a mock
 * model and without a worker.
 */
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { DEFAULT_CONTEXT_CHARACTERS, reduceMessages } from './context.ts';

const CLOSING_INSTRUCTION =
  'The tool results above are complete. Write the answer now, in the language the ' +
  'person wrote in, from what was found. Do not call any tool.';

/** The second try, when the first came back empty: the same ask with the
 * working written out as plain text and no tool definitions at all. Small
 * models that return nothing to a transcript of tool-role messages answer a
 * paragraph that says what the tools found. */
const FLAT_INSTRUCTION =
  'You already used tools for this question. Their results are quoted below. Write ' +
  'the answer now, in the language the person wrote in, from those results. Say plainly ' +
  'what they did not settle.';
/** How much of the working the flat retry carries. */
const FLAT_RESULTS_CHARACTERS = 12_000;

export type ClosingStepOptions = {
  model: LanguageModel;
  /** The run's tools, offered so providers that require definitions beside
   * tool calls in the history accept the request; `toolChoice: 'none'` keeps
   * them from being called. */
  tools?: ToolSet;
  instructions: string;
  /** The conversation before this turn, as UI messages. */
  messages: UIMessage[];
  signal: AbortSignal;
  contextCharacters?: number;
  /** A closing step that failed is logged, never surfaced: it was an extra
   * chance, and the run's own reason still stands. */
  onError?: (error: unknown) => void;
  /** Fired when the extra step actually runs, so a test can count it. */
  onClosingStep?: () => void;
};

/** Whether this chunk means the turn has produced something a person can read
 * or act on. The same rule as `answered()` in lib/runs/failure.ts, applied to
 * chunks rather than folded parts. */
function answers(chunk: UIMessageChunk): boolean {
  if (chunk.type === 'text-delta') return chunk.delta.trim().length > 0;
  if (chunk.type === 'file') return true;
  // Except the bookkeeping part naming which memories the prompt carried.
  if (chunk.type.startsWith('data-'))
    return chunk.type !== 'data-memories' && chunk.type !== 'data-research';
  // A failure or an abort is an ending of its own; a second step after it
  // would spend more on a turn that has already been explained.
  return chunk.type === 'error' || chunk.type === 'abort';
}

/** Whether the stream stopped on a person rather than on an answer. */
function pauses(chunk: UIMessageChunk): boolean {
  if (chunk.type === 'tool-approval-request') return true;
  // ask_user has no execute: its call is left in input-available and the
  // person is the implementation.
  return chunk.type === 'tool-input-available' && chunk.toolName === 'ask_user';
}

/** The UI message the chunks so far add up to, or undefined if they do not
 * fold (no `start` chunk, for instance). */
async function fold(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let message: UIMessage | undefined;
  try {
    for await (const value of readUIMessageStream({ stream })) message = value;
  } catch {
    return undefined;
  }
  return message;
}

/** The last thing the person asked, as text. */
function recentQuestion(messages: readonly UIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return (last?.parts ?? [])
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim()
    .slice(0, 2000);
}

const sum = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** The answer's recorded cost includes the step that produced the answer. */
function addUsage(metadata: unknown, extra: LanguageModelUsage): unknown {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const usage = (metadata as { usage?: LanguageModelUsage }).usage;
  if (!usage || typeof usage !== 'object') return metadata;
  return {
    ...metadata,
    usage: {
      ...usage,
      inputTokens: sum(usage.inputTokens, extra.inputTokens),
      outputTokens: sum(usage.outputTokens, extra.outputTokens),
      totalTokens: sum(usage.totalTokens, extra.totalTokens),
    },
  };
}

/**
 * The source stream, with one forced answering step appended when it ended
 * silent.
 *
 * The `finish` chunk is held back until the source ends, because the answer
 * has to arrive before it: a reader folding the stream closes the message on
 * `finish`, and text after that would belong to no message.
 */
/** The tool calls and results of a folded message, as text a model can read
 * without tool-role messages. */
export function flattenWorking(message: UIMessage): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    const typed = part as {
      type: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      state?: string;
    };
    if (!typed.type.startsWith('tool-') && typed.type !== 'dynamic-tool') continue;
    const name = typed.toolName ?? typed.type.replace(/^tool-/, '');
    const input = typed.input === undefined ? '' : JSON.stringify(typed.input);
    const output =
      typed.errorText ??
      (typed.output === undefined
        ? '(no result)'
        : typeof typed.output === 'string'
          ? typed.output
          : JSON.stringify(typed.output));
    lines.push(`### ${name}${input ? ' ' + input : ''}\n${output}`);
  }
  return lines.join('\n\n').slice(0, FLAT_RESULTS_CHARACTERS);
}

/** The words a model wrote to the person, from a stream's text chunks. */
function wroteText(chunks: readonly UIMessageChunk[]): boolean {
  return chunks.some((chunk) => chunk.type === 'text-delta' && chunk.delta.trim().length > 0);
}

export async function* withClosingStep(
  source: AsyncIterable<UIMessageChunk>,
  options: ClosingStepOptions,
): AsyncGenerator<UIMessageChunk> {
  const seen: UIMessageChunk[] = [];
  let answered = false;
  let paused = false;
  let held: UIMessageChunk | undefined;

  for await (const chunk of source) {
    if (chunk.type === 'finish') {
      held = chunk;
      continue;
    }
    // Only ever the last chunk in practice; if something follows it, keep the
    // order the source chose.
    if (held) {
      yield held;
      held = undefined;
    }
    seen.push(chunk);
    if (answers(chunk)) answered = true;
    if (pauses(chunk)) paused = true;
    yield chunk;
  }

  if (held && !answered && !paused && !options.signal.aborted) {
    try {
      const partial = await fold(seen);
      if (partial) {
        options.onClosingStep?.();
        const history = await convertToModelMessages([...options.messages, partial], {
          tools: options.tools,
          ignoreIncompleteToolCalls: true,
        });
        const result = streamText({
          model: options.model,
          instructions: options.instructions + '\n\n' + CLOSING_INSTRUCTION,
          messages: reduceMessages(
            history,
            options.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS,
          ),
          tools: options.tools,
          toolChoice: 'none',
          abortSignal: options.signal,
        });
        let failed = false;
        const written: UIMessageChunk[] = [];
        for await (const chunk of result.toUIMessageStream({
          sendStart: false,
          sendFinish: false,
          onError: (error) => {
            failed = true;
            options.onError?.(error);
            return 'closing step failed';
          },
        })) {
          if (chunk.type === 'error') {
            failed = true;
            break;
          }
          written.push(chunk);
          yield chunk;
        }
        if (!failed && held.type === 'finish')
          held = {
            ...held,
            messageMetadata: addUsage(held.messageMetadata, await result.totalUsage),
          };

        // Still nothing, or a refusal: once more, flat. The tool-role
        // transcript is what some small models return nothing to; the same
        // results quoted as text under a plain question is what they answer.
        // One more request, in the failure path only, and never with tools.
        if (!failed && !wroteText(written) && !options.signal.aborted) {
          const working = flattenWorking(partial);
          const question = recentQuestion(options.messages);
          options.onClosingStep?.();
          const flat = streamText({
            model: options.model,
            instructions: options.instructions + '\n\n' + FLAT_INSTRUCTION,
            messages: [
              {
                role: 'user',
                content:
                  (question ? 'Question: ' + question + '\n\n' : '') +
                  'Tool results:\n\n' +
                  (working || '(the tools returned nothing)'),
              },
            ],
            abortSignal: options.signal,
          });
          let flatFailed = false;
          for await (const chunk of flat.toUIMessageStream({
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              flatFailed = true;
              options.onError?.(error);
              return 'closing step failed';
            },
          })) {
            if (chunk.type === 'error') {
              flatFailed = true;
              break;
            }
            yield chunk;
          }
          if (!flatFailed && held.type === 'finish')
            held = {
              ...held,
              messageMetadata: addUsage(held.messageMetadata, await flat.totalUsage),
            };
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
  }

  if (held) yield held;
}
