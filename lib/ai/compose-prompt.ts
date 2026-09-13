/** The order the system prompt is assembled in, written down.
 *
 * The runs route built its instructions by concatenation —
 * `parsed.instructions + saved + contextNotes` — in the order the features
 * happened to be added, and each new one was appended to the end because that
 * was where the last one went. Order matters in a system prompt: what leads it
 * is what a truncating provider keeps and what a small model weights most.
 *
 * So the parts are named, the order is stated once here, and a test asserts it.
 * Adding a section means deciding where it goes, which is the decision that was
 * being made by accident.
 */

export type PromptParts = {
  /** The core rules and the person's own instructions, as the client sends
   * them: identity constraint first, because that is the one a truncated
   * prompt must still carry. */
  base?: string;
  /** The 22 principles, generated from lib/kernel/principles.json. Above the
   * retrieved material because they say how to treat it. */
  principles?: string;
  /** What this person saved and what the operator published. */
  knowledge?: string;
  /** Excerpts from this person's earlier conversations that share words with
   * the question. After their saved memories, which they chose on purpose,
   * and before the syntax notes. */
  recall?: string;
  /** The local syntax model's notes on the recent turns. */
  contextNotes?: string;
  /** What each connected MCP server says about when it is authoritative.
   * Last because it is the narrowest and the least trusted: it is written by
   * a third party, and a rule further up must not be displaced by it.
   *
   * In production this slot is filled by `withServerGuidance` in
   * lib/ai/run-agent.ts rather than by the route — which servers connected is
   * only known once the run starts, and a run resumed after the tab closed has
   * no request to carry it. It is named here so the whole order is written in
   * one place and can be asserted, not so the route fills it. */
  serverGuidance?: string;
};

/** The stated order. Exported so the test names sections rather than indexes. */
export const PROMPT_ORDER = [
  'base',
  'principles',
  'knowledge',
  'recall',
  'contextNotes',
  'serverGuidance',
] as const satisfies readonly (keyof PromptParts)[];

/**
 * One prompt from the named parts, in the stated order.
 *
 * Blank sections are dropped rather than left as empty paragraphs: a run with
 * no saved knowledge should not spend the model's attention on the gap where
 * knowledge would have been.
 */
export function composePrompt(parts: PromptParts): string {
  return PROMPT_ORDER.map((key) => parts[key]?.trim())
    .filter((section): section is string => !!section)
    .join('\n\n');
}
