/** An inactivity watchdog for provider streams.
 *
 * A wall-clock timeout is the wrong tool for a model call: a long reasoning
 * response is healthy and may legitimately take minutes, while a silent socket
 * is dead within seconds. The browser transport already made this distinction;
 * the server-side registry keeps it by resetting the deadline on every byte and
 * only giving up when nothing has arrived for `idleMs`.
 */
export const PROVIDER_IDLE_MS = 300_000;

/** A second bound, on the whole response rather than the gap between bytes.
 *
 * The idle deadline above resets on every byte, which is right — but it means
 * a provider dripping one token every few seconds holds a run, and one of the
 * worker's slots, for as long as it likes. Nothing else in the system ends it.
 * Twenty minutes is far above any healthy answer, including long reasoning
 * ones, so this only ever fires on something that has genuinely gone wrong.
 *
 * `HIKMAH_RUN_MAX_MS` overrides it, because the right number depends on the
 * models a deployment actually calls; 0 or a value that is not a positive
 * number means the default rather than "no bound", since an env var set to
 * nonsense must not silently remove a safety limit. */
const PROVIDER_MAX_MS = 20 * 60_000;

export function providerMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HIKMAH_RUN_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PROVIDER_MAX_MS;
}

export type WatchdogFetch = typeof fetch;

const idleMessage = (idleMs: number) =>
  `The model provider stopped sending data for ${Math.round(idleMs / 1000)} seconds. The request was cancelled; any answer received so far is preserved.`;

const overrunMessage = (maxMs: number) =>
  `The model provider was still sending after ${Math.round(maxMs / 60_000)} minutes. The request was cancelled; any answer received so far is preserved.`;

/**
 * Wrap `fetch` so a response that stalls is abandoned.
 *
 * The deadline is enforced on the stream this function returns, not only by
 * aborting the request signal. Aborting the signal is the polite path and is
 * done too, but a provider whose body stream ignores it would otherwise hang a
 * run forever, so the read is raced against the deadline directly.
 *
 * The caller's own signal is honoured as well, so cancelling a run cancels the
 * provider request rather than leaving it streaming, and billing, in the
 * background.
 */
export function withIdleTimeout(
  inner: WatchdogFetch = fetch,
  idleMs = PROVIDER_IDLE_MS,
  maxMs = PROVIDER_MAX_MS,
): WatchdogFetch {
  return async (input, init) => {
    // Started before the request, not at the first byte: a provider that takes
    // an hour to answer at all is the same problem as one that takes an hour
    // to finish answering.
    const startedAt = Date.now();
    const overrun = () => Date.now() - startedAt >= maxMs;
    const controller = new AbortController();
    const caller = init?.signal ?? undefined;
    const relay = () => controller.abort();
    if (caller) {
      if (caller.aborted) controller.abort();
      else caller.addEventListener('abort', relay, { once: true });
    }
    const release = () => caller?.removeEventListener('abort', relay);

    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Resolves when nothing has been read for idleMs. */
    const deadline = () =>
      new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => resolve('idle'), idleMs);
      });
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    let response: Response;
    try {
      response = await inner(input, { ...init, signal: controller.signal });
    } catch (error) {
      clear();
      release();
      throw error;
    }
    if (!response.body) {
      clear();
      release();
      return response;
    }

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const winner = await Promise.race([reader.read(), deadline()]);
          clear();
          // Checked after the read rather than on a timer of its own: one more
          // chunk past the cap is harmless, and a second timer would have to be
          // cleaned up on every path this function already gets right.
          if (winner !== 'idle' && !winner.done && overrun()) {
            controller.abort();
            void reader.cancel().catch(() => {});
            release();
            target.error(new Error(overrunMessage(maxMs)));
            return;
          }
          if (winner === 'idle') {
            controller.abort();
            void reader.cancel().catch(() => {});
            release();
            target.error(new Error(idleMessage(idleMs)));
            return;
          }
          if (winner.done) {
            release();
            target.close();
            return;
          }
          target.enqueue(winner.value);
        } catch (error) {
          clear();
          release();
          target.error(error);
        }
      },
      cancel(reason) {
        clear();
        release();
        controller.abort();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
