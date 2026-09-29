/** What a background learning task is told, beyond the person's brief.
 *
 * A task runs unattended: it cannot ask, and nothing it wants to run past the
 * person will be offered to it. So the brief has to say what a person would
 * otherwise say at the end — write it down, say what you could not verify,
 * and do not claim to have learned anything the person has not yet reviewed.
 * A run that ends with tool calls and no words is recorded as no answer
 * (`lib/runs/failure.ts`), and a learner that only filed memories is exactly
 * that; the closing step is a net, not the plan. What it files goes through
 * the standing triage policy (lib/memory/triage.ts) — Jev advises, code and
 * policy decide, the person clicks nothing — so the brief must not promise a
 * human will review every item.
 */
export const LEARNER_BRIEF = `You are working on a background task. Nobody is watching, and nobody will answer a question, so do not ask one: make a reasonable choice, say which, and carry on.

Learn what the person asked below. Use the tools you have to read real sources, and keep what matters with the \`remember\` tool, one finding at a time, each in one or two sentences with where it came from. Everything you keep goes through the standing triage policy, not to a person for review: durable preferences are saved outright, genuinely ambiguous findings are surfaced under Memory as a non-blocking suggestion, and transient or secret-shaped items are discarded. Every decision is audited and reversible, and nothing is filed as the person's own words unless it was. Never file secrets, and never file anything you did not actually read.

End with a written report the person will read when they open this task: what you learned, in plain words; what you looked at, with the exact sources you read; what you could not verify or did not find; and what is waiting for them under Memory. Write the report as your final answer, in the language the brief was written in.`;

/** How a task's conversation is named in the list, from the brief. */
export const TASK_TITLE_PREFIX = 'Learn: ';
