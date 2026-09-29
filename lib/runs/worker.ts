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
import { describeFailure, operatorRun, NO_ANSWER } from './failure.ts';
import { answerIdFor } from './answer-id.ts';
import { createRunStore, type RunRow, type RunStore } from './store.ts';
import type { SqliteHandle } from './store.ts';
import { executionRunConfig } from '../../server/run-credentials.mjs';
import { safeDiagnostic } from './safe-error.ts';
import {
  phaseChunk,
  reasonCodeFor,
  type RunPhase,
  type RunReasonCode,
  type RunSegment,
} from './telemetry.ts';
import { BudgetExhaustedError } from '../ai/budget-middleware.ts';

/** How often to look for queued work when idle. */
const POLL_MS = 400;

export type RunEvent = { seq: number; payload: unknown };
export type RunListener = (event: RunEvent) => void;

type Subscriber = { onEvent: RunListener; onEnd?: () => void };

/** Process-local fan-out to any SSE responses currently tailing a run. */
export class RunBus {
  private listeners = new Map<string, Set<Subscriber>>();

  /** `onEnd` fires when the run reaches a terminal state, so a tailing response
   * can close instead of hanging open until the client gives up. */
  subscribe(runId: string, onEvent: RunListener, onEnd?: () => void): () => void {
    const set = this.listeners.get(runId) ?? new Set<Subscriber>();
    const subscriber: Subscriber = { onEvent, onEnd };
    set.add(subscriber);
    this.listeners.set(runId, set);
    return () => {
      set.delete(subscriber);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  emit(runId: string, event: RunEvent) {
    this.deliver(runId, (subscriber) => subscriber.onEvent(event));
  }

  /** Signal that no further events will arrive for this run. */
  end(runId: string) {
    this.deliver(runId, (subscriber) => subscriber.onEnd?.());
    this.listeners.delete(runId);
  }

  private deliver(runId: string, call: (subscriber: Subscriber) => void) {
    const set = this.listeners.get(runId);
    if (!set) return;
    // A listener that throws (a disconnected response, say) must not stop the
    // run or starve the other listeners.
    for (const subscriber of set) {
      try {
        call(subscriber);
      } catch {
        set.delete(subscriber);
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
  /** Telemetry for the drive: timed segments and progress phases (PR-07).
   * Present when the worker drives; a test driver may omit it. */
  telemetry?: {
    /** Record one timed segment. Names and durations only — the signature
     * takes no payload, so prompt text and secrets cannot enter telemetry. */
    recordSegment: (segment: RunSegment, durationMs: number) => void;
    /** Announce a progress phase on the run's event stream. */
    phase: (phase: RunPhase, reasonCode?: RunReasonCode) => void;
  };
}) => Promise<{
  message?: unknown;
  /** The stream stopped on a tool the owner has to approve, not on an answer. */
  awaitingApproval?: boolean;
  /** The stream stopped on a question only the owner can answer. */
  awaitingClient?: boolean;
  /** The loop ended without writing an answer — tool calls and no words. */
  silent?: boolean;
} | void>;

export type WorkerOptions = {
  db: SqliteHandle;
  /** Runs one claimed run. Injected so the loop is testable without a provider. */
  drive: RunDriver;
  bus?: RunBus;
  pollMs?: number;
  /** How many runs may be driven at once. One, as it always was, unless said
   * otherwise. Above one, the last slot is kept for a chat: a background task
   * is claimed only while no other task is running. */
  concurrency?: number;
  /** How long after a cancel's abort to wait for the driver to settle the run
   * itself before the worker settles it as cancelled. A driver hung in an
   * await that ignores the abort would otherwise leave the run marked running
   * forever — and the sidebar's "Still answering" badge with it. */
  cancelGraceMs?: number;
  onError?: (error: unknown, run: RunRow) => void;
  /** Runs after a successful answer is durable. Its failure must never turn a
   * completed conversation into a failed one. Pauses/cancellation skip it. */
  onCompleted?: (input: {
    run: RunRow;
    messages: unknown[];
    message: unknown;
  }) => Promise<void> | void;
};

export type Worker = {
  store: RunStore;
  bus: RunBus;
  /** Whether the poll loop is armed. Reported by /api/health. */
  readonly started: boolean;
  /** How many runs are being driven right now. Reported by /api/health. */
  readonly active: number;
  /** Claim and drive one queued run, if a slot is free. Returns the run it
   * handled, or null. */
  tick(): Promise<RunRow | null>;
  start(): void;
  stop(): Promise<void>;
  cancel(runId: string): boolean;
};

/** Whether a run is a background task rather than a turn of a chat. Read from
 * the stored configuration, the same field the chat-only claim tests. */
function isTask(run: RunRow): boolean {
  try {
    const config = JSON.parse(run.config) as { task?: unknown };
    return Boolean(config && typeof config === 'object' && config.task);
  } catch {
    return false;
  }
}

export function createWorker(options: WorkerOptions): Worker {
  const store = createRunStore(options.db);
  const bus = options.bus ?? new RunBus();
  const running = new Map<string, AbortController>();
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  let timer: ReturnType<typeof setInterval> | undefined;
  // A count, not a flag. One flag meant one run process-wide, so a long
  // background task would have frozen every live chat for its whole duration.
  let active = 0;
  // Tasks in flight, kept apart from the count above: with more than one slot,
  // the last is never given to a task, so a chat always has somewhere to run.
  let tasks = 0;
  let stopped = false;

  /** Announce a progress phase on a run's event stream (PR-07): one stored
   * chunk plus the live fan-out, so a tailing client and a reconnecting one
   * see the same sequence. Carries the phase and the reason code only. */
  function announce(runId: string, phase: RunPhase, reasonCode?: RunReasonCode) {
    const chunk = phaseChunk(runId, phase, reasonCode);
    const seq = store.appendEvent(runId, chunk);
    bus.emit(runId, { seq, payload: chunk });
  }

  async function tick(): Promise<RunRow | null> {
    if (active >= concurrency || stopped) return null;
    active += 1;
    let run: RunRow | null = null;
    let task = false;
    try {
      run = store.claimNext({ chatOnly: concurrency > 1 && tasks >= concurrency - 1 });
      if (!run) return null;
      task = isTask(run);
      if (task) tasks += 1;

      // The queue wait ends at the claim: how long the run sat before a slot
      // opened. created_at is the submit moment — the route writes the row
      // when the run is accepted.
      store.recordSegment(run.id, 'queue_wait', Date.now() - Date.parse(run.created_at));
      announce(run.id, 'starting');

      const controller = new AbortController();
      running.set(run.id, controller);
      const emit = (chunk: unknown) => {
        const seq = store.appendEvent(run!.id, chunk);
        bus.emit(run!.id, { seq, payload: chunk });
        return seq;
      };
      try {
        const result = await options.drive({
          run,
          messages: store.listMessages(run.conversation_id),
          signal: controller.signal,
          emit,
          telemetry: {
            recordSegment: (segment: RunSegment, durationMs: number) =>
              store.recordSegment(run!.id, segment, durationMs),
            phase: (phase: RunPhase, reasonCode?: RunReasonCode) =>
              announce(run!.id, phase, reasonCode),
          },
        });

        if (controller.signal.aborted) {
          announce(run.id, 'cancelled', 'cancelled');
          store.finish(run.id, 'cancelled', undefined, 'cancelled');
        } else {
          // Persist the finished answer, then drop the resume buffer: once the
          // message is a row, replaying chunks would duplicate it.
          if (result?.message) {
            const message = result.message as {
              id?: string;
              role?: string;
              // The tree parent the run's answer belongs under, stamped onto
              // the run config by the runs route (Chat v2 message branching):
              // a regenerated answer is a sibling of the one it replaces, not
              // a child of whatever the active path ended at mid-run.
              [key: string]: unknown;
            };
            let replyParentId: string | null = null;
            try {
              const config = JSON.parse(run.config ?? '{}') as {
                replyParentId?: unknown;
              };
              replyParentId =
                typeof config.replyParentId === 'string' ? config.replyParentId : null;
            } catch {
              replyParentId = null;
            }
            // Idempotent: a resumed run's message carries the id of the turn
            // it is continuing, so this is an update, not a second row.
            //
            // Blank, not absent. `createAgentUIStream` folded through
            // `readUIMessageStream` returns `id: ''`, so `??` kept the empty
            // string and every answer in the deployment was written under that
            // one id: the first inserted, a second in another conversation hit
            // the primary key and destroyed the answer, and a second in the
            // same conversation quietly overwrote the first. The run id is the
            // right fallback because it is stable across a resume of this run
            // and unique across every other.
            store.saveAssistantMessage(
              run.conversation_id,
              {
                id: message.id?.trim() ? message.id : answerIdFor(run.id),
                role: message.role ?? 'assistant',
                parts: message.parts ?? [],
                // Model and token usage, so a reload can still say what the
                // answer cost.
                metadata: message.metadata,
              },
              replyParentId,
            );
          }
          store.pruneEvents(run.id);
          // Waiting on a person is not finishing. The run keeps its place so the
          // answer, when it comes, resumes this run rather than starting a new
          // one over the same conversation. Two ways to be waiting, and they are
          // not interchangeable: an approval carries yes or no, a question
          // carries what the person said. Each transition carries its reason
          // code (PR-07), announced on the stream like every other phase.
          if (result?.awaitingApproval) {
            store.setStatus(run.id, 'waiting_approval');
            store.setReasonCode(run.id, 'awaiting-approval');
            announce(run.id, 'awaiting-approval', 'awaiting-approval');
          } else if (result?.awaitingClient) {
            store.setStatus(run.id, 'waiting_client');
            store.setReasonCode(run.id, 'awaiting-answer');
            announce(run.id, 'awaiting-answer', 'awaiting-answer');
          }
          // A loop that ended with tool calls and no words is not a success.
          // Recorded as one, it left a transcript showing the working and then
          // nothing at all — no answer, no error, and nothing to press.
          else if (result?.silent) {
            announce(run.id, 'failed', 'no-answer');
            store.finish(run.id, 'failed', NO_ANSWER, 'no-answer');
          } else {
            announce(run.id, 'done', 'completed');
            store.finish(run.id, 'done', undefined, 'completed');
            if (result?.message && options.onCompleted) {
              try {
                await options.onCompleted({
                  run,
                  messages: store.listMessages(run.conversation_id),
                  message: result.message,
                });
              } catch {
                // No raw exception: it could contain the provider key that
                // the privacy filter was resolving. The answer stays done.
                console.error('[hikmah] completed exchange was not captured');
              }
            }
          }
        }
      } catch (error) {
        let key = '';
        try {
          key = executionRunConfig(run).apiKey;
        } catch {
          /* Decryption errors are already generic. */
        }
        const safe = new Error(safeDiagnostic(error, key ? [key] : []));
        if (error instanceof Error) safe.name = error.name;
        options.onError?.(safe, run);
        if (controller.signal.aborted) {
          announce(run.id, 'cancelled', 'cancelled');
          store.finish(run.id, 'cancelled', undefined, 'cancelled');
        } else {
          // The provider's own words where there are any, and a sentence the
          // person can act on where the fault is ours. Either way the raw
          // exception has already gone to the log through onError above.
          //
          // The operator sees the real text: they are the one who could read
          // that log, and "the details are in the server log" is a dead end
          // offered to someone with no way to open one from the interface.
          //
          // The machine-readable reason travels with it (PR-07): a budget the
          // run itself exhausted, a first byte that never came, a provider
          // fault, or our own bug.
          const reasonCode: RunReasonCode =
            error instanceof BudgetExhaustedError ? 'budget-exhausted' : reasonCodeFor(error);
          announce(run.id, 'failed', reasonCode);
          store.finish(
            run.id,
            'failed',
            describeFailure(safe, { operator: operatorRun(run.config) }),
            reasonCode,
          );
        }
      } finally {
        running.delete(run.id);
        // Whatever the outcome, tailing responses must be told to close.
        bus.end(run.id);
      }
      return run;
    } finally {
      if (task) tasks -= 1;
      active -= 1;
    }
  }

  return {
    store,
    bus,
    tick,
    get started() {
      return timer !== undefined;
    },
    get active() {
      return active;
    },
    start() {
      if (timer) return;
      // Anything left marked running belongs to a process that is gone.
      store.requeueRunning();
      stopped = false;
      timer = setInterval(() => {
        // One claim per free slot. Each tick claims synchronously before it
        // awaits the driver, so the later calls see the earlier claims and a
        // queue of two is not left waiting a whole poll for its second.
        for (let slot = active; slot < concurrency; slot += 1) void tick();
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
        // A driver that ignores the abort — hung in an await that never
        // listens to the signal — would otherwise leave the run marked
        // running forever, and the sidebar's "Still answering" badge with it,
        // across reloads. If the drive has not settled the run itself within
        // the grace period, settle it here. The store's finish is idempotent
        // over terminal states, so a drive that settles late cannot resurrect
        // the run or flip its recorded outcome.
        const grace = Math.max(0, options.cancelGraceMs ?? 5_000);
        const forceFinish = setTimeout(() => {
          try {
            const run = store.getRun(runId);
            if (run && !store.isTerminal(run.status)) {
              store.finish(runId, 'cancelled', undefined, 'cancelled');
              announce(runId, 'cancelled', 'cancelled');
            }
          } catch {
            /* the store is gone; nothing left to settle */
          }
        }, grace);
        (forceFinish as unknown as { unref?: () => void }).unref?.();
        return true;
      }
      // Not started yet: mark it so the worker never picks it up.
      const run = store.getRun(runId);
      if (run && !store.isTerminal(run.status)) {
        store.finish(runId, 'cancelled', undefined, 'cancelled');
        announce(runId, 'cancelled', 'cancelled');
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
