/**
 * Bounding the wait for a stream's first item.
 *
 * Free-tier providers queue server-side, and a call that never produces a
 * first token used to stall a run silently for minutes: the person watched
 * "Planning the answer…" with zero tokens and nothing to act on. Racing only
 * the first item keeps the fix narrow — once an answer is flowing, a slow
 * middle is the idle watchdog's job, not this one's.
 *
 * The timeout fires `onTimeout` (the caller aborts the hung provider call
 * there) and the generator then throws `makeError()`. Awaiting the first item
 * is the only bounded part: every item after it is yielded unbounded.
 */
export async function* withFirstByteLimit<T>(
  source: AsyncIterable<T>,
  ms: number,
  onTimeout: () => void,
  makeError: () => Error,
): AsyncGenerator<T, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(makeError());
    }, ms);
  });
  let first: IteratorResult<T>;
  try {
    // The race subscribes to both, so whichever loses is still handled: no
    // unhandled rejection when the timer is cleared below, and no dangling
    // timer when the source wins.
    first = await Promise.race([iterator.next(), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (first.done) return;
  yield first.value;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}
