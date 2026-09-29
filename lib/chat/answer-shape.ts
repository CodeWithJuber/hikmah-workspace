// Truncated pyramid for long answers (P2-15): the essential answer renders
// first, the rest sits behind an inline disclosure ("Show full breakdown").
// This is a render-side shape only — it never summarises or rewrites the
// model's words, it just decides where the fold goes.
//
// The split is conservative on purpose: only settled assistant answers longer
// than LONG_ANSWER_CHARS, cut at a blank-line boundary (which never splits a
// table or paragraph), and only when the lead's fenced code blocks are
// balanced. Anything uncertain returns null and the answer renders whole.

/** Answers at or under this length always render whole. Named in tests via the
 *  boundary behaviour, not imported — the constant is an implementation
 *  detail of the fold. */
const LONG_ANSWER_CHARS = 3000;
/** The lead aims to end near this length, at the last blank line before it. */
const LEAD_TARGET_CHARS = 1200;

export type AnswerPyramid = { lead: string; rest: string };

const isFenceLine = (line: string) => /^\s*(```|~~~)/.test(line);

/** Split a long answer into lead + rest, or null when it should render whole. */
export function splitAnswerLead(text: string): AnswerPyramid | null {
  if (!text || text.length < LONG_ANSWER_CHARS) return null;
  const lines = text.split('\n');
  // The lead is whole lines up to the last blank-line boundary at or before
  // the target — blank lines never occur inside a table or a paragraph.
  let cut = -1;
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' && chars > 0 && chars <= LEAD_TARGET_CHARS) cut = i;
    chars += lines[i].length + 1;
    if (chars > LEAD_TARGET_CHARS) break;
  }
  if (cut < 1) return null;
  const lead = lines.slice(0, cut).join('\n').trimEnd();
  const rest = lines.slice(cut).join('\n').trim();
  if (!lead || !rest) return null;
  // A lead ending inside an unclosed fence would render half a code block.
  const fences = lead.split('\n').filter(isFenceLine).length;
  if (fences % 2 !== 0) return null;
  return { lead, rest };
}
