/** Which paused run, if any, a message releases.
 *
 * A run can stop on a person in two ways, and they are not interchangeable. An
 * approval carries yes or no, and is answered by an `approval-responded` part.
 * A question carries what the person said, and is answered by the output of the
 * one tool with no server-side execute. Matching them loosely would let an
 * approval release a run waiting on an answer, resuming work whose actual pause
 * nobody addressed.
 *
 * Pure and separate from the route so it can be tested without a worker, a
 * database or a session.
 */
import type { RunStatus } from './store.ts';

/** The tool the owner answers. The only one whose output may come from a
 * browser, because it is the only one with no `execute` on the server. */
export const ASK_USER_PART = 'tool-ask_user';

type Part = { type?: string; state?: string };
type Message = { role?: string; parts?: Part[] };

/** Does this message carry a decision for a tool that was waiting on one? */
export function hasApprovalResponse(message: Message): boolean {
  return (message.parts ?? []).some((part) => part.state === 'approval-responded');
}

/**
 * Did the owner answer a waiting approval with a denial?
 *
 * The approval-responded part carries the verdict (`approval.approved`). A
 * denial is a run-level transition worth recording on its own: the run resumes
 * into a transcript where the tool it wanted was refused, and stamping the
 * `denied` reason code (PR-07) is what makes that visible in the timeline.
 */
export function approvalDenied(message: Message): boolean {
  return (message.parts ?? []).some(
    (part) =>
      part.state === 'approval-responded' &&
      (part as { approval?: { approved?: unknown } }).approval?.approved === false,
  );
}

/**
 * Does this message answer a question the run stopped on?
 *
 * Both halves matter. An answered call is what resumes the run; an unanswered
 * one still present means the owner has only got through some of what was
 * asked, and sending early would resume with a question outstanding.
 */
export function hasAnsweredQuestion(message: Message): boolean {
  const questions = (message.parts ?? []).filter((part) => part.type === ASK_USER_PART);
  return (
    questions.some((part) => part.state === 'output-available') &&
    !questions.some((part) => part.state === 'input-available')
  );
}

export type Release = 'approval' | 'answer' | null;

/** What this message releases on a run in this state, or null for nothing. */
export function releases(status: RunStatus | undefined, message: Message | undefined): Release {
  if (!message || message.role !== 'assistant') return null;
  if (status === 'waiting_approval' && hasApprovalResponse(message)) return 'approval';
  if (status === 'waiting_client' && hasAnsweredQuestion(message)) return 'answer';
  return null;
}

/** Statuses in which a run has stopped and is waiting on a person. */
export function isPausedOnPerson(status: RunStatus | undefined): boolean {
  return status === 'waiting_approval' || status === 'waiting_client';
}

/**
 * Will this run produce any more output without someone doing something?
 *
 * A tab that reloads onto a paused run used to open a stream that could never
 * yield anything and never closed, because a pause is not a terminal status.
 * The client stayed in "streaming" for as long as the tab was open, and its
 * automatic send — the thing that delivers the approval or the answer — only
 * fires when the chat is idle. So the card rendered, the owner answered, and
 * nothing happened.
 *
 * A pause is therefore an ending as far as the stream is concerned: there is
 * nothing to tail until the person replies, and their reply starts a new stream
 * of its own.
 */
export function streamIsFinished(status: RunStatus | undefined, terminal: boolean): boolean {
  return terminal || isPausedOnPerson(status);
}

/**
 * Is there genuinely nothing left for a tailing client to receive?
 *
 * A failed run is the case this exists for. Its reason is a column, and a run
 * that failed before emitting a single chunk — a provider rejecting the key, say
 * — has no events at all. Answering "nothing to send" there returns 204, the
 * browser sees a stream that merely stopped, and the owner is told only "An
 * error occurred" while the actual reason sits in the database.
 */
export function nothingToSend(
  run: { status?: RunStatus; error?: string | null; event_seq?: number } | null | undefined,
  pendingEvents: number,
  terminal: boolean,
  /** The client's cursor. The failure notice sits one past every stored chunk,
   * so a cursor at or beyond that has already been told. */
  after = -1,
): boolean {
  if (pendingEvents > 0) return false;
  if (run?.status === 'failed' && run.error && after < (run.event_seq ?? 0)) return false;
  return streamIsFinished(run?.status, terminal);
}
