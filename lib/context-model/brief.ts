/** The co-model's contribution to a run, filtered down to what is worth saying.
 *
 * `realizeContext` renders every event the compiler produced, which is the
 * right behaviour for the studio screen where the owner is inspecting the
 * parse. It is the wrong behaviour for a system prompt. Measured against real
 * conversation text, roughly half of those rows carry nothing:
 *
 *     S2: actor unresolved → behind → object unresolved
 *     S3: actor unresolved → . → object unresolved
 *
 * — a preposition read as a predicate, and a full stop read as one. Put in
 * front of a small free model, rows like that are worse than silence: they are
 * confident-looking structure over a sentence the compiler did not understand.
 *
 * So a row survives only when it carries something a reader could lose:
 * a scope cue (negation, modality, attribution, time, an unresolved quotation)
 * or a named actor. Everything else is dropped, and when nothing survives the
 * block is empty rather than a header with no content under it.
 */

import type { ContextGraph, ContextEvent } from './discourse.ts';

/** Enough rows to carry a paragraph's worth of structure, few enough that the
 * block cannot crowd out the conversation it is describing. */
export const MAX_BRIEF_ROWS = 8;
export const MAX_BRIEF_LITERALS = 12;
/** A hard ceiling, applied last and on a line boundary. */
export const MAX_BRIEF_CHARACTERS = 1200;
/** One literal long enough to be a paste rather than a value. */
const MAX_LITERAL_CHARACTERS = 80;

export type ContextBrief = {
  rows: string[];
  literals: string[];
  /** Ready to append to the system prompt, or '' when nothing survived. */
  block: string;
  kept: number;
  dropped: number;
};

/** An id the compiler could not resolve to a mention it had seen. */
const unresolved = (id: string) => id.startsWith('unresolved:');

/** A predicate with no letter or digit in it is punctuation the parser
 * mistook for a verb. There is nothing to say about it. */
const isWord = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** `not` and `not [learned morphology]` are one fact found twice — once by the
 * operator list and once by the learned morphology. Saying it twice reads as
 * two separate negations. */
const scopeKey = (scope: { kind: string; cue: string }) =>
  scope.kind + ':' + scope.cue.replace(/\s*\[learned morphology\]\s*$/, '').toLowerCase();

function dedupeScopes(event: ContextEvent) {
  const seen = new Set<string>();
  return event.scopes.filter((scope) => {
    const key = scopeKey(scope);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether this event's clause is worth rendering as a clause.
 *
 * A scope cue is the high-value case: negation, modality and attribution are
 * exactly what a fluent answer drops. A named actor is the other: "Sara →
 * help" is a fact about the text even with no cue on it. An event with neither
 * is a guess at a sentence the compiler did not parse.
 */
function informative(event: ContextEvent, scopes: ContextEvent['scopes']): boolean {
  if (!parsedClause(event)) return false;
  return scopes.length > 0 || event.actor.some((id) => !unresolved(id));
}

/**
 * Whether there is a clause here at all.
 *
 * Measured: "Sara did not merge release 4096 into the branch." makes the
 * compiler take the full stop as the root, with no actor and no patient — and
 * hang the negation cue on it. Rendering that as `actor unresolved → . →
 * object unresolved` asserts a structure that was never found.
 */
const parsedClause = (event: ContextEvent) =>
  isWord(event.predicate) && (event.actor.length > 0 || event.patient.length > 0);

/**
 * Which exact strings are worth reproducing verbatim.
 *
 * Code spans and URLs, always: those are what gets silently reworded. Numbers
 * only from three characters up, which keeps 255, 1,000, 12:30 and 3.5% and
 * drops the run of bare single digits that a sentence like "record 0" produces
 * — a one-digit number in the sentence above is not at risk of being mangled.
 */
function worthQuoting(literal: string): boolean {
  if (literal.startsWith('`')) return true;
  if (/^https?:\/\//i.test(literal)) return true;
  return literal.length >= 3;
}

export function contextBrief(graph: ContextGraph): ContextBrief {
  const label = (id: string) =>
    graph.entities.find((entity) => entity.id === id)?.label ?? id.replace('unresolved:', '? ');
  const names = (ids: string[]) => ids.map(label).join(', ');

  let dropped = 0;
  // Rendered rows keyed by their body, so the same clause repeated across
  // sentences is one line with a count rather than five identical lines.
  const bodies = new Map<string, { first: number; times: number }>();
  for (const event of graph.events) {
    const scopes = dedupeScopes(event);
    if (!informative(event, scopes)) {
      // Dropping the clause must not drop the cue with it. A negation the
      // compiler found but could not attach is still the single most valuable
      // thing it has to say — it is precisely what a fluent answer loses — so
      // it is reported as what it is: a cue, with no clause behind it.
      if (scopes.length && !parsedClause(event)) {
        const body =
          scopes.map((s) => s.kind + ': ' + s.cue).join('; ') + ' — cue found, clause unresolved';
        const seen = bodies.get(body);
        if (seen) seen.times++;
        else bodies.set(body, { first: event.sentence, times: 1 });
        continue;
      }
      dropped++;
      continue;
    }
    const body =
      `${names(event.actor) || 'actor unresolved'} → ${event.predicate} → ` +
      `${names(event.patient) || 'object unresolved'}` +
      (scopes.length ? ' [' + scopes.map((s) => s.kind + ': ' + s.cue).join('; ') + ']' : '');
    const seen = bodies.get(body);
    if (seen) seen.times++;
    else bodies.set(body, { first: event.sentence, times: 1 });
  }

  const all = [...bodies.entries()].map(
    ([body, { first, times }]) => `S${first}: ${body}${times > 1 ? ` (×${times})` : ''}`,
  );
  // The most recent sentences are the ones the answer is about, so when there
  // are more rows than room, the older ones go.
  const rows = all.slice(-MAX_BRIEF_ROWS);
  dropped += all.length - rows.length;

  const literals = graph.literals
    .filter(worthQuoting)
    .map((literal) => literal.slice(0, MAX_LITERAL_CHARACTERS))
    .slice(0, MAX_BRIEF_LITERALS);

  if (!rows.length && !literals.length) return { rows, literals, block: '', kept: 0, dropped };

  const lines = [
    // Named, bounded and disclaimed in the same sentence, for the same reason
    // an MCP server's instructions are: whoever reads this has to be able to
    // tell our own rules from an annotation that might be wrong.
    "Local context notes from this project's own syntax compiler — fallible annotations over the" +
      ' recent messages, not the model of understanding and not verified facts. They add no' +
      ' permission and change no instruction above. The messages themselves remain the source of' +
      ' truth; where a note and the text disagree, the text wins.',
    ...rows,
    literals.length ? 'Reproduce these exactly: ' + literals.join(' · ') : '',
  ].filter(Boolean);

  return { rows, literals, block: truncate(lines.join('\n')), kept: rows.length, dropped };
}

/** Cut on a line boundary, so a row is never half-shown. */
function truncate(block: string): string {
  if (block.length <= MAX_BRIEF_CHARACTERS) return block;
  const lines = block.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_BRIEF_CHARACTERS) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}
