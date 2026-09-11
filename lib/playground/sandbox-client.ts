/** Running JavaScript in the isolated QuickJS runtime.
 *
 * One worker, reused. It used to be one worker per call, which meant the WASM
 * module was compiled and instantiated from scratch on every single run — and
 * that boot had to fit inside the same ten seconds the program itself was given.
 * On a modest machine a first run therefore reported a timeout instead of a
 * result, having never actually run anything.
 *
 * Startup and execution are now budgeted apart, because they fail for different
 * reasons: booting is slow work that finishes, while a program still going after
 * ten seconds is stuck.
 */

export type SandboxResult = {
  runtime: string;
  stdout: string;
  result: string;
  error?: string;
  elapsedMs: number;
  network: boolean;
  hostAccess: boolean;
};

/** Compiling the runtime is slow on a small machine, and slower on a cold cache.
 * This is a ceiling on something that does finish, not a limit on the program. */
const STARTUP_MS = 45_000;
/** A program still running after this is not slow, it is stuck. QuickJS also
 * interrupts the guest itself at three seconds; this is the outer guarantee. */
const RUN_MS = 15_000;

type Pending = { resolve: (value: SandboxResult) => void; reject: (error: Error) => void };

let worker: Worker | undefined;
let ready: Promise<void> | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Drop the worker so the next call builds a fresh one. Used whenever it can no
 * longer be trusted: it failed to start, it was terminated, or it died. */
function discard(reason: string) {
  for (const call of pending.values()) call.reject(Error(reason));
  pending.clear();
  worker?.terminate();
  worker = undefined;
  ready = undefined;
}

function connect(): Promise<void> {
  if (ready) return ready;
  // Served as a pre-built ES module rather than bundled by the app's own
  // pipeline: Next's webpack emits this as a classic worker whatever the type
  // says, and QuickJS cannot survive being loaded through importScripts. See
  // scripts/build-sandbox-worker.mjs.
  const started = new Worker('/sandbox-worker.js', { type: 'module' });
  worker = started;

  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      discard('The JavaScript runtime took too long to start. Reload and try again.');
      reject(Error('The JavaScript runtime took too long to start. Reload and try again.'));
    }, STARTUP_MS);

    started.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        ready?: boolean;
        id?: number;
        value?: SandboxResult;
        error?: string;
      };
      // The first message is the handshake; everything after carries a call id.
      if (data.ready !== undefined) {
        clearTimeout(timer);
        if (data.ready) resolve();
        else {
          const message = data.error ?? 'The JavaScript runtime could not start.';
          discard(message);
          reject(Error(message));
        }
        return;
      }
      const call = data.id !== undefined ? pending.get(data.id) : undefined;
      if (!call) return;
      pending.delete(data.id!);
      if (data.error) call.reject(Error(data.error));
      else call.resolve(data.value as SandboxResult);
    };

    started.onerror = () => {
      clearTimeout(timer);
      const message = 'The JavaScript runtime could not start. Reload and try again.';
      discard(message);
      reject(Error(message));
    };
  });

  // An unobserved rejection here would be an unhandled promise: every caller
  // awaits `connect()`, but the stored promise outlives the call that made it.
  ready.catch(() => {});
  return ready;
}

/** Compile the runtime now, so the first run does not pay for it.
 *
 * Safe to call more than once and safe to ignore: a failure here surfaces again,
 * with the same words, on the run that actually needs it. */
export function warmSandbox(): void {
  void connect().catch(() => {});
}

export async function runJavascript(code: string, signal?: AbortSignal): Promise<SandboxResult> {
  if (typeof code !== 'string' || !code.trim() || code.length > 40000)
    throw Error('Enter JavaScript up to 40,000 characters.');
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');

  await connect();

  const id = nextId++;
  return new Promise<SandboxResult>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', stop);
    };
    // A stuck guest cannot be called off politely, so the worker goes with it
    // and the next run starts a new one.
    const stop = () => {
      finish();
      discard('Stopped');
      reject(new DOMException('Stopped', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish();
      discard('The program did not finish in time.');
      reject(Error('The program did not finish within 15 seconds and was stopped.'));
    }, RUN_MS);

    pending.set(id, {
      resolve: (value) => {
        finish();
        resolve(value);
      },
      reject: (error) => {
        finish();
        reject(error);
      },
    });

    signal?.addEventListener('abort', stop, { once: true });
    worker?.postMessage({ id, code });
  });
}
