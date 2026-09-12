/** Server-Sent Events for run output.
 *
 * SSE rather than WebSockets: the traffic is one-way, it reconnects on its own,
 * it carries a resume cursor in a standard header, and it passes through Caddy
 * with no upgrade handling. The only thing the client sends back is a cancel,
 * which is an ordinary POST.
 *
 * Every event carries its sequence number as the SSE id, so a client that drops
 * mid-answer reconnects with Last-Event-ID and receives exactly what it missed.
 */
import type { RunBus, RunEvent } from './worker.ts';
import type { RunStore } from './store.ts';

/** Comment frame every 15s so proxies do not treat a quiet run as dead. */
const KEEPALIVE_MS = 15_000;

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform, private',
  Connection: 'keep-alive',
  // Caddy does not buffer text/event-stream, but an intermediate proxy might.
  'X-Accel-Buffering': 'no',
};

/** Read the resume cursor from either the standard header or the query. */
export function resumeCursor(request: Request): number {
  const header = request.headers.get('last-event-id');
  const url = new URL(request.url);
  const raw = header ?? url.searchParams.get('after');
  const parsed = Number.parseInt(raw ?? '', 10);
  // -1 means "send everything": sequence numbers start at 0.
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
}

function frame(event: RunEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

/**
 * Replay everything after `after`, then tail the live run.
 *
 * The replay and the subscription are ordered deliberately: subscribe first,
 * then read the stored events, then drop any live event whose sequence the
 * replay already covered. Doing it the other way round loses any chunk written
 * between the read and the subscribe.
 */
export function runEventStream(options: {
  runId: string;
  after: number;
  store: RunStore;
  bus: RunBus;
  signal?: AbortSignal;
  keepaliveMs?: number;
}): ReadableStream<Uint8Array> {
  const { runId, after, store, bus } = options;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let highest = after;
      const pending: RunEvent[] = [];
      let replaying = true;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const push = (event: RunEvent) => {
        if (event.seq <= highest) return;
        highest = event.seq;
        send(frame(event));
      };

      const unsubscribe = bus.subscribe(
        runId,
        (event) => {
          if (replaying) pending.push(event);
          else push(event);
        },
        // The worker signals the end of every run, so a tailing response closes
        // instead of hanging open until the client gives up.
        () => finish(),
      );

      function finish() {
        if (closed) return;
        // Why the run stopped, if it stopped badly. The worker records the
        // reason on the row and nothing used to forward it, so every failure
        // reached the owner as the SDK's own "An error occurred." — no key, a
        // rejected model and a provider outage all looked identical, and the
        // one thing that would have told them apart was already written down.
        //
        // Sent as a UI-message error chunk because that is the shape useChat
        // surfaces as `error`, and it is the last thing on the wire.
        const ended = store.getRun(runId);
        if (ended?.status === 'failed' && ended.error)
          send(`data: ${JSON.stringify({ type: 'error', errorText: ended.error })}\n\n`);
        closed = true;
        unsubscribe();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      const keepalive = setInterval(
        () => send(': keep-alive\n\n'),
        options.keepaliveMs ?? KEEPALIVE_MS,
      );
      (keepalive as unknown as { unref?: () => void }).unref?.();

      options.signal?.addEventListener('abort', finish, { once: true });

      // Replay what is already stored, then flush anything that arrived while
      // we were reading it.
      for (const event of store.eventsAfter(runId, after)) push(event);
      replaying = false;
      for (const event of pending) push(event);
      pending.length = 0;

      // A run that already finished has nothing to tail.
      const run = store.getRun(runId);
      if (!run || store.isTerminal(run.status)) finish();
    },
  });
}
