/** Separating what an answer *is* from how it was arrived at.
 *
 * The transcript rendered every part in the order the model produced them, so
 * reasoning, tool calls, MCP calls and the answer itself were one interleaved
 * column. The owner's words: you cannot tell where the MCP call happened, where
 * the actual response is, where the thinking is, or what Hikmah added.
 *
 * So the parts are sorted into three kinds, and the surface renders them as
 * three things rather than one list. Pure, so the classification and the
 * summary line can be tested without a browser.
 */

export type TranscriptPart = { type: string; state?: string; [key: string]: unknown };

export type GroupedParts<T extends TranscriptPart = TranscriptPart> = {
  /** Reasoning and finished tool calls: the working, collapsed by default. */
  working: T[];
  /** The answer itself. */
  answer: T[];
  /** Anything the reader has to see or act on: a question, a tool waiting for
   * approval, a plan, a comparison, a file, a generated image. Never collapsed —
   * hiding a question leaves the run waiting for an answer nobody can see. */
  live: T[];
};

const LIVE = new Set([
  'data-plan',
  'data-compare',
  'file',
  'source-url',
  'source-document',
  'step-start',
]);

const isTool = (type: string) => type.startsWith('tool-') || type === 'dynamic-tool';

/** A tool that is still asking something of the reader belongs in front of them. */
const waiting = (part: TranscriptPart) =>
  part.type === 'tool-ask_user' ||
  part.state === 'approval-requested' ||
  part.state === 'input-available';

/** Generic over the caller's own part type, so the caller gets its own type
 * back and can render the groups with the renderer it already has. */
export function groupParts<T extends TranscriptPart>(parts: readonly T[]): GroupedParts<T> {
  const grouped: GroupedParts<T> = { working: [], answer: [], live: [] };
  for (const part of parts) {
    if (part.type === 'text') grouped.answer.push(part);
    else if (LIVE.has(part.type)) grouped.live.push(part);
    else if (isTool(part.type) && waiting(part)) grouped.live.push(part);
    else if (part.type === 'reasoning' || isTool(part.type)) grouped.working.push(part);
    else grouped.live.push(part);
  }
  return grouped;
}

/** `mcp__quran__fetch_tafsir` → the server and the tool, separately.
 *
 * A reader asking "where did this come from" is asking which server answered,
 * and the raw id buries that in the middle of an identifier. Parsed here rather
 * than imported from lib/mcp/manager, which pulls the MCP SDK into the browser
 * bundle for one string split.
 */
export function toolProvenance(type: string): { server?: string; tool: string } {
  const name = type.startsWith('tool-') ? type.slice('tool-'.length) : type;
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp'
    ? { server: parts[1], tool: parts.slice(2).join('__') }
    : { tool: name };
}

/** Plain names for the built-ins, so the working reads as sentences rather than
 * as identifiers. Anything absent falls back to its own name with the
 * underscores taken out, which is right for a tool added later. */
const PLAIN: Record<string, string> = {
  search_web: 'searched the web',
  read_webpage: 'read a page',
  search_reference: 'checked a reference',
  research_quran: 'checked the local Qur’an index',
  run_javascript: 'ran a calculation',
  calculate: 'calculated',
  bash: 'ran a command',
  sandbox_run: 'ran a program',
  ssh_exec: 'ran a command on a saved machine',
  list_ssh_hosts: 'listed saved machines',
  read_file: 'read a file',
  write_file: 'wrote a file',
  list_files: 'listed files',
  delete_file: 'deleted a file',
  generate_image: 'generated an image',
  generate_speech: 'generated speech',
  interpret_meaning: 'parsed a sentence locally',
  update_plan: 'updated the plan',
};

/**
 * One line saying what was actually done, for the collapsed header.
 *
 * Named sources first and in the order they were used, because "which source
 * answered this" is the question being asked. Thinking is counted, never
 * quoted: the core prompt forbids private chain-of-thought and a summary line
 * is not the place to start showing it.
 */
export function describeWorking(working: readonly TranscriptPart[]): string {
  const did: string[] = [];
  let thoughts = 0;
  for (const part of working) {
    if (part.type === 'reasoning') {
      thoughts++;
      continue;
    }
    const { server, tool } = toolProvenance(part.type);
    const label = server
      ? `asked ${server}` + (tool ? ` (${tool.replace(/_/g, ' ')})` : '')
      : (PLAIN[tool] ?? tool.replace(/_/g, ' '));
    if (!did.includes(label)) did.push(label);
  }
  if (!did.length && !thoughts) return '';
  const steps = working.length === 1 ? '1 step' : `${working.length} steps`;
  if (!did.length) return `Thought it through · ${steps}`;
  const listed =
    did.slice(0, 3).join(', ') + (did.length > 3 ? `, and ${did.length - 3} more` : '');
  // Sentence case, because it reads as a sentence.
  return listed.charAt(0).toUpperCase() + listed.slice(1) + ` · ${steps}`;
}
