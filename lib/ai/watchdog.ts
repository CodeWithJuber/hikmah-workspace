/** An inactivity watchdog for provider streams.
 *
 * A wall-clock timeout is the wrong tool for a model call: a long reasoning
 * response is healthy and may legitimately take minutes, while a silent socket
 * is dead within seconds. The browser transport already made this distinction;
 * the server-side registry keeps it by resetting the deadline on every byte and
 * only giving up when nothing has arrived for `idleMs`.
 */
export const PROVIDER_IDLE_MS = 300_000;

export type WatchdogFetch = typeof fetch;

const idleMessage = (idleMs: number) =>
  `The model provider stopped sending data for ${Math.round(idleMs / 1000)} seconds. The request was cancelled; any answer received so far is preserved.`;

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
): WatchdogFetch {
  return async (input, init) => {
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
