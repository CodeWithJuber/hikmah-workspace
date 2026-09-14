/** A browser fetch that cannot wait forever.
 *
 * Every panel on the chat surface fetched with a bare `fetch` and a `let live`
 * boolean: no signal, no timeout, no retry. That is fine while the server
 * answers. It is not fine when the server is busy — and this app's server is
 * single-threaded and writes SQLite synchronously while a run streams, so
 * "busy" is a state it genuinely reaches. A request with no deadline then never
 * settles, the panel keeps its skeleton, and the page looks hung. Twenty-five
 * call sites had this shape.
 *
 * So: one deadline, one way to say it failed, and a caller's own signal
 * composed in rather than replaced. `lib/playground/transport.ts` already does
 * this well for provider streams, where the right rule is an *idle* timeout
 * because a stream legitimately runs for minutes; these are ordinary JSON
 * requests, where a total deadline is the honest bound.
 */

/** Long enough for a slow phone on a slow network; short enough that a person
 * finds out rather than waiting. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export class RequestFailed extends Error {
  /** True when nothing came back in time, rather than the server saying no. */
  readonly timedOut: boolean;
  /** The HTTP status, when there was a response at all. */
  readonly status?: number;

  constructor(message: string, options: { timedOut?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'RequestFailed';
    this.timedOut = options.timedOut ?? false;
    this.status = options.status;
  }
}

export type RequestOptions = RequestInit & {
  /** Total time allowed, not idle time. */
  timeoutMs?: number;
};

/**
 * `fetch`, with a deadline and this app's cookie rule.
 *
 * Throws `RequestFailed` when the deadline passes, so a caller can tell "it
 * took too long" from "it said no" and show something a person can act on.
 * A non-2xx response is returned rather than thrown: plenty of callers read the
 * status themselves, and turning every 404 into an exception would be a bigger
 * change than this is meant to be.
 */
export async function clientFetch(url: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  // The caller's signal still cancels; the deadline is added to it, never
  // instead of it. Unmounting a panel must still stop its request.
  const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;

  try {
    return await fetch(url, { credentials: 'same-origin', ...init, signal: composed });
  } catch (cause) {
    if (deadline.aborted)
      throw new RequestFailed(`This took longer than ${Math.round(timeoutMs / 1000)}s.`, {
        timedOut: true,
      });
    throw cause;
  }
}
