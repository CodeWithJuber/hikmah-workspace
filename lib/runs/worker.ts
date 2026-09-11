/** The in-process run worker.
 *
 * One worker, one process, no queue service. That is a deliberate fit to the
 * deployment: a single owner on one container with SQLite. The cost is that a
 * second replica would need a shared bus; the benefit is no Redis, no second
 * database and no extra container for a workload that is one person's chat.
 *
 * The worker is what makes a run survive the tab that started it. The browser
 * posts a message and disconnects whenever it likes; the run continues here and
 * its output is replayable from the store.
 */
import { readUIMessageStream } from 'ai';
import { createRunStore, type RunRow, type RunStore } from './store.ts';
import type { SqliteHandle } from './store.ts';

/** How often to look for queued work when idle. */
const POLL_MS = 400;

export type RunEvent = { seq: number; payload: unknown };
export type RunListener = (event: RunEvent) => void;

/** Process-local fan-out to any SSE responses currently tailing a run. */
export class RunBus {
  private listeners = new Map<string, Set<RunListener>>();

  subscribe(runId: string, listener: RunListener): () => void {
    const set = this.listeners.get(runId) ?? new Set<RunListener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  emit(runId: string, event: RunEvent) {
    const set = this.listeners.get(runId);
    if (!set) return;
    // A listener that throws (a disconnected response, say) must not stop the
    // run or starve the other listeners.
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        set.delete(listener);
      }
    }
  }
}

export type RunDriver = (context: {
  run: RunRow;
  /** Persisted conversation so far, as UI messages. */
  messages: unknown[];
  signal: AbortSignal;
  /** Record one streamed chunk. Returns its sequence number. */
  emit: (chunk: unknown) => number;
}) => Promise<{ message?: unknown } | void>;

export type WorkerOptions = {
  db: SqliteHandle;
  /** Runs one claimed run. Injected so the loop is testable without a provider. */
  drive: RunDriver;
  bus?: RunBus;
  pollMs?: number;
  onError?: (error: unknown, run: RunRow) => void;
};

export type Worker = {
  store: RunStore;
  bus: RunBus;
  /** Drive at most one queued run. Returns the run it handled, or null. */
  tick(): Promise<RunRow | null>;
  start(): void;
  stop(): Promise<void>;
  cancel(runId: string): boolean;
};

export function createWorker(options: WorkerOptions): Worker {
  const store = createRunStore(options.db);
  const bus = options.bus ?? new RunBus();
  const running = new Map<string, AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let stopped = false;

  async function tick(): Promise<RunRow | null> {
    if (busy || stopped) return null;
    busy = true;
    let run: RunRow | null = null;
    try {
      run = store.claimNext();
      if (!run) return null;

      const controller = new AbortController();
      running.set(run.id, controller);
      try {
        const result = await options.drive({
          run,
          messages: store.listMessages(run.conversation_id),
          signal: controller.signal,
          emit: (chunk) => {
            const seq = store.appendEvent(run!.id, chunk);
            bus.emit(run!.id, { seq, payload: chunk });
            return seq;
          },
        });

        if (controller.signal.aborted) {
          store.finish(run.id, 'cancelled');
        } else {
          // Persist the finished answer, then drop the resume buffer: once the
          // message is a row, replaying chunks would duplicate it.
          if (result?.message) {
            const message = result.message as { id?: string; role?: string; parts?: unknown };
            store.appendMessage(run.conversation_id, {
              id: message.id ?? run.id + '-answer',
              role: message.role ?? 'assistant',
              parts: message.parts ?? [],
              metadata: undefined,
            });
          }
          store.pruneEvents(run.id);
          store.finish(run.id, 'done');
        }
      } catch (error) {
        options.onError?.(error, run);
        if (controller.signal.aborted) store.finish(run.id, 'cancelled');
        else
          store.finish(
            run.id,
            'failed',
            error instanceof Error ? error.message : 'The run failed.',
          );
      } finally {
        running.delete(run.id);
      }
      return run;
    } finally {
      busy = false;
    }
  }

  return {
    store,
    bus,
    tick,
    start() {
      if (timer) return;
      // Anything left marked running belongs to a process that is gone.
      store.requeueRunning();
      stopped = false;
      timer = setInterval(() => {
        void tick();
      }, options.pollMs ?? POLL_MS);
      // Do not hold the process open for the poll timer.
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of running.values()) controller.abort();
      // Hand back anything in flight so the next boot picks it up rather than
      // leaving it stranded as running. Best effort: this runs on shutdown, and
      // a database already closed by an earlier handler must not turn a clean
      // stop into an unhandled error that masks the real shutdown reason.
      try {
        store.requeueRunning();
      } catch {
        /* already closed */
      }
    },
    cancel(runId: string) {
      const controller = running.get(runId);
      if (controller) {
        controller.abort();
        return true;
      }
      // Not started yet: mark it so the worker never picks it up.
      const run = store.getRun(runId);
      if (run && !store.isTerminal(run.status)) {
        store.finish(runId, 'cancelled');
        return true;
      }
      return false;
    },
  };
}

/** Fold a run's stored chunks back into a UI message. */
export async function messageFromEvents(chunks: unknown[]): Promise<unknown> {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: unknown;
  for await (const message of readUIMessageStream({ stream: stream as never })) last = message;
  return last;
}
