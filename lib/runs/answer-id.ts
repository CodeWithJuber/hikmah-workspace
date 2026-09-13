/** The one id an answer has, on the server and in the browser.
 *
 * A fresh turn's `start` chunk names no message, so the browser used to make
 * an id up while the worker stored the answer as `<run>-answer`. The two never
 * met: answering an approval on a live stream re-sends the message by the
 * browser's id, the store found no such row, and the person was told the
 * answer "no longer matches the paused turn" — every time, on every live Allow.
 * The id is decided here and put on the first chunk instead.
 */

export function answerIdFor(runId: string): string {
  return runId + '-answer';
}

/** The `start` chunk with the run's answer id, when it names none. A resumed
 * turn's `start` already names the stored message; that is kept. */
export function nameAnswer<T>(chunk: T, runId: string): T {
  const typed = chunk as { type?: string; messageId?: string };
  return typed?.type === 'start' && !typed.messageId
    ? ({ ...typed, messageId: answerIdFor(runId) } as T)
    : chunk;
}
