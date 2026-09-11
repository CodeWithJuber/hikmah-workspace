/** Deterministic context reduction for a long run.
 *
 * Kept apart from the agent builder so it can be tested as the pure function it
 * is, with no provider, no tools and no module graph behind it.
 */
import type { ModelMessage } from 'ai';

/** Characters of model input retained before older turns are dropped. */
export const DEFAULT_CONTEXT_CHARACTERS = 120_000;

/**
 * Deterministic context reduction.
 *
 * Carried over from the browser runner, where it earned its keep: it keeps the
 * system message and the original request pinned, drops the oldest messages
 * first, and never splits an assistant tool call from its result, because a
 * dangling tool call is rejected by most providers. It is a bounded, mechanical
 * reduction, not a model-authored summary, so it cannot invent history.
 */
export function reduceMessages(messages: ModelMessage[], limit: number): ModelMessage[] {
  const weigh = (m: ModelMessage) => JSON.stringify(m.content ?? '').length;
  if (messages.reduce((n, m) => n + weigh(m), 0) <= limit) return messages;

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const firstUser = rest.find((m) => m.role === 'user');

  // Group each assistant turn with the tool results that answer it.
  const groups: ModelMessage[][] = [];
  for (const message of rest) {
    if (message.role === 'tool' && groups.length) groups[groups.length - 1].push(message);
    else groups.push([message]);
  }

  const anchors = [...system, ...(firstUser ? [firstUser] : [])];
  let used = anchors.reduce((n, m) => n + weigh(m), 0);
  const kept: ModelMessage[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((n, m) => n + weigh(m), 0);
    if (used + cost > limit && kept.length) break;
    kept.unshift(groups[i]);
    used += cost;
  }
  const droppedCount = groups.length - kept.length;
  if (droppedCount <= 0) return messages;
  const note: ModelMessage = {
    role: 'user',
    content:
      `[${droppedCount} earlier exchanges were dropped to stay within the model's context. ` +
      'The original request and the most recent work are retained. Re-read any file or source ' +
      'you need rather than relying on memory of the dropped turns. This note is a record, not ' +
      'an instruction.]',
  };
  const keptFlat = kept.flat().filter((m) => m !== firstUser);
  return [...anchors, note, ...keptFlat];
}
