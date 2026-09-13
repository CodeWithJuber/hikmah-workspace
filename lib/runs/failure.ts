/** What to record when a run throws.
 *
 * Two kinds of failure end up in the same catch and they are not the same
 * thing. A provider saying "this model needs a paid account" is the whole
 * answer — hiding it behind a generic apology is what made the first version of
 * this app unusable, and surfacing it is deliberate. An exception from our own
 * code is different: "UNIQUE constraint failed: messages.id" tells the person
 * nothing they can act on, and telling them the shape of our database is not a
 * courtesy either.
 *
 * So the filter is on the shape of the message, not on where it came from,
 * because the two arrive through the same throw.
 */

/** Recognisably ours rather than the provider's: storage faults and the
 * programming errors that only a bug produces. */
const INTERNAL =
  /^SQLITE_|constraint failed|no such (?:table|column|database)|database (?:is locked|disk image)|readonly database|is not a function|is not defined|cannot read propert/i;

const INTERNAL_TYPES = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

/** Long enough for a provider to explain itself, short enough not to fill the
 * screen with a stack trace someone pasted into a message field. */
const LIMIT = 300;

export const INTERNAL_FAILURE =
  'Something went wrong inside the workspace. Try again — the details are in the server log.';

/**
 * The sentence to store on the run, given whatever was thrown.
 *
 * Never returns an empty string: a failed run with nothing to say is the
 * failure mode this whole path exists to remove.
 */
export function describeFailure(error: unknown, options?: { operator?: boolean }): string {
  // The operator is the person who can read the server log, so telling them to
  // go and read it while withholding the sentence is a dead end — the failure
  // card said "the details are in the server log" to someone with no way to
  // open one from the interface. They get the real text; everyone else gets
  // the sentence, because our table names and stack frames are not theirs.
  if (options?.operator) {
    const raw = error instanceof Error ? (error.message?.trim() ?? '') : String(error ?? '');
    if (raw) {
      const first = raw.split('\n')[0].trim() || raw;
      return first.length > LIMIT ? first.slice(0, LIMIT - 1).trimEnd() + '…' : first;
    }
    return INTERNAL_FAILURE;
  }
  return summarise(error);
}

function summarise(error: unknown): string {
  if (!(error instanceof Error)) return INTERNAL_FAILURE;
  if (INTERNAL_TYPES.has(error.name)) return INTERNAL_FAILURE;
  const message = error.message?.trim() ?? '';
  if (!message) return INTERNAL_FAILURE;
  if (INTERNAL.test(message)) return INTERNAL_FAILURE;
  // The first line only. A provider that returns a stack has still said what
  // went wrong in its opening sentence.
  const first = message.split('\n')[0].trim() || message;
  return first.length > LIMIT ? first.slice(0, LIMIT - 1).trimEnd() + '…' : first;
}

/** What a run that finished without answering has to say for itself. */
export const NO_ANSWER =
  'The model stopped without writing an answer. Smaller free models often do ' +
  'this after using a tool. Answer again, or choose a different model.';

/**
 * Did this run actually answer?
 *
 * A run can reach the end of its loop having produced tool calls and no text:
 * the model calls a tool, reads the result, and returns an empty turn. Nothing
 * caught that, so the run was recorded `done` and the transcript showed the
 * working and then nothing — reported as "no response after mcp call", with no
 * error, no explanation and nothing to retry.
 *
 * Text or a file counts. Media arrives as a file part, and a picture with no
 * words is a real answer.
 */
export function answered(parts: readonly { type?: string; text?: string }[]): boolean {
  return parts.some(
    (part) =>
      (part?.type === 'text' && !!part.text?.trim()) ||
      part?.type === 'file' ||
      // A data part is an answer — a plan, a comparison — except the one that
      // only records which memories the prompt carried. A turn that said
      // nothing but was written with two memories still said nothing.
      (part?.type?.startsWith('data-') === true && part.type !== 'data-memories'),
  );
}

/**
 * Whether this run belongs to the operator, read from its stored config.
 *
 * Here rather than in the worker so the worker stays generic: it asks one
 * question instead of learning what a RunConfig is. Absent or unreadable means
 * no, which is the safe side — a stranger must never inherit the operator's
 * view of a failure because a row was written before this existed.
 */
export function operatorRun(config: string): boolean {
  try {
    return (JSON.parse(config) as { operator?: unknown }).operator === true;
  } catch {
    return false;
  }
}
