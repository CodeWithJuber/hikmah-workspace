/** A chat transport for runs that belong to the server.
 *
 * `DefaultChatTransport` expects one request that answers with the stream. The
 * durable route deliberately does not work that way: POSTing a message queues a
 * run and returns its id straight away, and the output is tailed separately from
 * a replayable log. That split is the whole point — it is what lets the tab
 * close mid-answer and rejoin later — so the transport has to bridge it.
 *
 * Two things follow from the log being replayable, and both are handled here
 * rather than by the caller:
 *
 * - Every event carries its sequence number, so a dropped connection resumes
 *   from the last one seen instead of restarting the answer or losing the middle
 *   of it.
 * - A closed body does not mean the run ended. The server closes when the run
 *   finishes, but so does a proxy with an idle timeout. Asking again from the
 *   cursor tells the two apart: 204 means finished, a stream means carry on.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

export type DurableTransportOptions = {
  /** Run configuration sent with the first turn; replaced by `setConfig`. */
  config: Record<string, unknown>;
  /** Injected by the tests. */
  fetch?: typeof globalThis.fetch;
};

/**
 * A transport that also owns what the caller needs to know about the run.
 *
 * The configuration and the run in flight live here rather than in the view
 * because the transport outlives every render that could change them: useChat
 * captures it once per conversation and ignores later ones, so a view holding
 * these would have no way to reach the instance actually sending the requests.
 */
export type DurableChatTransport = ChatTransport<UIMessage> & {
  /** Use this configuration from the next turn on. */
  setConfig: (config: Record<string, unknown>) => void;
  /** The run currently producing output, or null. */
  activeRun: () => string | null;
};

/** How many times to re-open a stream that ended without the run finishing. */
/** Run states that are stopped on a person rather than working. A new message
 * is not an answer to either, so neither will produce output for it. */
const PAUSED = new Set(['waiting_approval', 'waiting_client']);

const MAX_CONTINUATIONS = 200;
/** Backoff between attempts after a failed read, in milliseconds. */
const RETRY_DELAYS = [250, 500, 1000, 2000];

/** The blank line that ends an event. Not /g: each call starts from the front
 * of what is left, and a sticky lastIndex would skip past it. */
const SEPARATOR = /\r?\n\r?\n/;

/** One SSE event: the sequence number and the chunk it carried. */
type Frame = { id: number | null; data: string };

/**
 * Split an SSE body into events.
 *
 * Written out rather than taken from a library because the sequence id is load
 * bearing here: it is the resume cursor, so it has to survive parsing.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      // A blank line ends an event, and the wire format allows \r\n even though
      // this server does not emit it.
      let boundary = SEPARATOR.exec(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const frame = parseEvent(raw);
        if (frame) yield frame;
        boundary = SEPARATOR.exec(buffer);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseEvent(raw: string): Frame | null {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // A comment is the keep-alive, which exists to hold the connection open
    // through a proxy and carries nothing.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'id') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) id = parsed;
    }
  }
  return data.length ? { id, data: data.join('\n') } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tail a run from `after`, reconnecting across drops, until it is finished.
 *
 * The cursor only ever moves forward, so a reconnect can neither repeat a chunk
 * the caller has already folded in nor skip one it has not.
 */
export function runStream(options: {
  runId: string;
  after?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): ReadableStream<UIMessageChunk> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let cursor = options.after ?? -1;

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      let attempt = 0;
      try {
        for (let opened = 0; opened < MAX_CONTINUATIONS; opened += 1) {
          if (options.signal?.aborted) break;

          let response: Response;
          try {
            response = await doFetch(
              `/api/runs/${encodeURIComponent(options.runId)}/stream?after=${cursor}`,
              { headers: { Accept: 'text/event-stream' }, signal: options.signal },
            );
          } catch (error) {
            // A failed connection is worth retrying: the run is still being
            // driven on the server and its output is waiting in the log.
            if (options.signal?.aborted) break;
            if (attempt >= RETRY_DELAYS.length) throw error;
            await sleep(RETRY_DELAYS[attempt++]);
            continue;
          }

          // Nothing left to send and nothing still running.
          if (response.status === 204) break;
          if (!response.ok || !response.body) {
            const message = await response
              .json()
              .then((value: { error?: string }) => value?.error)
              .catch(() => undefined);
            throw new Error(message ?? 'The run could not be read.');
          }

          attempt = 0;
          let received = false;
          for await (const frame of readEvents(response.body, options.signal)) {
            received = true;
            if (frame.id !== null) cursor = frame.id;
            try {
              controller.enqueue(JSON.parse(frame.data) as UIMessageChunk);
            } catch {
              /* a frame that is not JSON is not one the worker wrote */
            }
          }
          if (options.signal?.aborted) break;
          // The body ended. Whether that was the run finishing or a proxy
          // timing out is answered by asking again: 204 above ends the loop.
          if (!received) await sleep(RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)]);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** POST a turn, then tail whatever run it produced. */
export function createDurableChatTransport(options: DurableTransportOptions): DurableChatTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  let config = options.config;
  let activeRun: string | null = null;

  async function queue(
    chatId: string,
    messages: UIMessage[],
    signal?: AbortSignal,
    trigger?: string,
  ) {
    const response = await doFetch(`/api/conversations/${encodeURIComponent(chatId)}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the last message is new; the rest are already rows on the server.
      //
      // Except when answering again. useChat drops its own answer and re-sends
      // the message before it — which is already a row — so without the trigger
      // the server inserts it a second time against a primary key and the whole
      // turn fails with "The run could not be started." The trigger tells it to
      // truncate that message and everything after it first.
      //
      // The id to truncate from is always the re-sent message's own, whatever
      // useChat put in `messageId`: it slices its list to end at the message
      // being replayed, so that message is both the one to remove and the one
      // to write back.
      body: JSON.stringify({ ...config, messages: messages.slice(-1), trigger }),
      signal,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      runId?: string;
      error?: string;
      alreadyRunning?: boolean;
      status?: string | null;
    };
    // 409 means this conversation already has a run, and what to do about it
    // depends on what that run is doing.
    //
    // Queued or streaming: tailing it is the honest answer to a double submit —
    // the work is happening, just not from this click, and failing here would
    // hide a run that is already producing output.
    //
    // Paused on a person: it will never produce another token until the
    // question above is answered, so attaching to its stream shows nothing at
    // all. That is how three messages in a row got no reply and no error — each
    // was displayed by the browser, refused by the server, and quietly attached
    // to a run that had stopped. Say so instead.
    if (payload.alreadyRunning && PAUSED.has(payload.status ?? ''))
      throw new Error(
        payload.status === 'waiting_approval'
          ? 'This conversation is waiting for you to allow or refuse something above. Answer that first.'
          : 'This conversation is waiting for your answer to the question above.',
      );
    if (!payload.runId) throw new Error(payload.error ?? 'The run could not be started.');
    return payload.runId;
  }

  return {
    setConfig(next) {
      config = next;
    },
    activeRun: () => activeRun,

    async sendMessages({ chatId, messages, abortSignal, trigger }) {
      const runId = await queue(chatId, messages, abortSignal, trigger);
      activeRun = runId;
      return runStream({ runId, signal: abortSignal, fetch: doFetch });
    },

    async reconnectToStream({ chatId, abortSignal }) {
      // On a fresh load the browser knows the conversation but not the run, so
      // the server is asked which one is in flight.
      const response = await doFetch(`/api/conversations/${encodeURIComponent(chatId)}/runs`, {
        headers: { Accept: 'application/json' },
        signal: abortSignal,
      });
      if (!response.ok) return null;
      const { runId } = (await response.json().catch(() => ({}))) as { runId?: string | null };
      activeRun = runId ?? null;
      if (!runId) return null;
      return runStream({ runId, signal: abortSignal, fetch: doFetch });
    },
  };
}

/** Stop a run on the server. Closing the socket no longer stops anything. */
export async function cancelRun(runId: string, doFetch = globalThis.fetch): Promise<boolean> {
  const response = await doFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) return false;
  const { stopped } = (await response.json().catch(() => ({}))) as { stopped?: boolean };
  return Boolean(stopped);
}
