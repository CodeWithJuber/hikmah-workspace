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
export function describeFailure(error: unknown): string {
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
