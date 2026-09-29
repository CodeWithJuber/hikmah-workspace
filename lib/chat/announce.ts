// The transcript's polite live region says "Working on your request." while a
// run is busy and must announce once, briefly, when the answer lands — then
// go quiet again so it doesn't linger for assistive tech.
//
// The 2026 kubaik finding: per-chunk live-region updates break VoiceOver, so
// the answer is never streamed into the region; only the transition is
// announced. The full answer text is never announced (a long answer read aloud
// in full would be hostile); the reader finds it in the transcript log.

/** The statuses useChat reports for a run. Kept as strings so the helper stays
 *  decoupled from the AI SDK's exact union type. */
export type ChatRunStatus = 'submitted' | 'streaming' | 'ready' | 'error' | string;

/** True on the exact commit a streaming run settles: previous status was
 *  'streaming' and the new one is no longer busy. 'submitted' is still busy
 *  (the model hasn't started), so streaming→submitted is not a finish. */
export function streamingJustSettled(prev: ChatRunStatus, next: ChatRunStatus): boolean {
  return prev === 'streaming' && next !== 'streaming' && next !== 'submitted';
}

/** How a run settled, for the polite live region. A stop is announced as
 *  stopped and a failure as failed — "Response ready." after either would be
 *  the region lying to assistive tech. */
export type SettledOutcome = 'ready' | 'stopped' | 'error';

/** What the polite live region should read for the current run state. */
export function busyAnnouncement(busy: boolean, justFinished: false | SettledOutcome): string {
  if (busy) return 'Working on your request.';
  if (justFinished === 'stopped') return 'Response stopped.';
  if (justFinished === 'error') return 'The request failed.';
  if (justFinished === 'ready') return 'Response ready.';
  return '';
}
