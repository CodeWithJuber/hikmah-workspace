/** Deterministic context reduction for a long run.
 *
 * Kept apart from the agent builder so it can be tested as the pure function it
 * is, with no provider, no tools and no module graph behind it.
 */
import type { ModelMessage } from 'ai';

/** Characters of model input retained before older turns are dropped.
 *
 * A ceiling the owner can lower, not a budget: `historyBudget` below decides
 * what actually fits, from the model's own window. */
export const DEFAULT_CONTEXT_CHARACTERS = 120_000;

/** What to assume when the provider publishes no context length.
 *
 * The same number the composer's meter falls back to, deliberately: the figure
 * a person is shown and the figure the run budgets against have to be one
 * number, or the meter reads 30% while the request is already over. */
export const ASSUMED_CONTEXT_TOKENS = 32_000;

/**
 * Characters per token, deliberately low.
 *
 * English averages about four. Arabic, Urdu and Hindi are far worse on a
 * vocabulary trained mostly on English — often two or fewer — and this app
 * answers in the user's language, so budgeting at four would overshoot the
 * window on exactly the conversations it exists to protect.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * Characters to reserve per tool offered.
 *
 * Measured: the 21 built-in descriptions are 4,670 characters, mean 222, and
 * each also travels as a JSON Schema of names, types and constraints. MCP
 * servers write longer descriptions than we do, and the Qur'an server alone
 * adds fifteen tools. 600 is that measurement rounded up rather than a guess.
 */
const PER_TOOL_CHARS = 600;

/** Room for the answer itself. A request that fills the window leaves the model
 * nowhere to reply. */
const OUTPUT_RESERVE_TOKENS = 4_000;

/** Below this a conversation cannot carry its own previous turn, which makes
 * the budget a way to break the chat rather than to protect it. */
const MIN_HISTORY_CHARS = 2_000;

/**
 * How much conversation actually fits, in characters.
 *
 * Nothing computed this before. Every run reduced history at a flat 120,000
 * characters — about 30,000 tokens — whatever model it was talking to, while
 * the catalogue's `context_length` was read only in the browser to draw the
 * meter. On a model with a 32,000-token window that is the whole window spent
 * on history before the system prompt, before thirty-odd tool schemas and
 * before any room to answer, so the provider truncated the request. What it
 * truncates first is the front: the system prompt, which is where the identity
 * rule and the Qur'an grounding live.
 */
export function historyBudget(options: {
  /** The model's window in tokens, when the provider publishes one. */
  contextWindow?: number;
  /** Characters of system prompt this run carries. */
  instructions: number;
  /** How many tools the model is offered. */
  tools: number;
  /** The owner's own ceiling. */
  ceiling?: number;
}): number {
  const window =
    Number.isFinite(options.contextWindow) && (options.contextWindow ?? 0) > 0
      ? (options.contextWindow as number)
      : ASSUMED_CONTEXT_TOKENS;
  const reserve =
    options.instructions + options.tools * PER_TOOL_CHARS + OUTPUT_RESERVE_TOKENS * CHARS_PER_TOKEN;
  const fits = window * CHARS_PER_TOKEN - reserve;
  const ceiling = options.ceiling ?? DEFAULT_CONTEXT_CHARACTERS;
  return Math.max(MIN_HISTORY_CHARS, Math.min(ceiling, fits));
}

/**
 * Deterministic context reduction.
 *
 * Keeps the system messages, drops the oldest turns first, and never splits an
 * assistant tool call from its result, because a dangling tool call is rejected
 * by most providers. It is a bounded, mechanical reduction, not a model-authored
 * summary, so it cannot invent history.
 */
export function reduceMessages(messages: ModelMessage[], limit: number): ModelMessage[] {
  const weigh = (m: ModelMessage) => JSON.stringify(m.content ?? '').length;
  if (messages.reduce((n, m) => n + weigh(m), 0) <= limit) return messages;

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  // Group each assistant turn with the tool results that answer it.
  const groups: ModelMessage[][] = [];
  for (const message of rest) {
    if (message.role === 'tool' && groups.length) groups[groups.length - 1].push(message);
    else groups.push([message]);
  }

  // The system messages, and nothing else.
  //
  // This used to pin the conversation's *first* user message here as well,
  // carried over from the browser agent runner where one run had one task and
  // keeping it stopped the agent drifting. A chat is not one task. The effect
  // was that after a dozen turns on other subjects, every request still opened
  // with the question the person asked first — so the answers read as the whole
  // conversation stirred together, which is exactly how it was reported. The
  // current turn needs no anchor: it is the newest group, and the loop below
  // always keeps at least that one.
  const anchors = [...system];
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
      'The most recent turns are retained; anything older is gone. Re-read any file or source ' +
      'you need rather than relying on memory of the dropped turns, and if the request depends ' +
      'on something no longer shown, ask. This note is a record, not an instruction.]',
  };
  return [...anchors, note, ...kept.flat()];
}
