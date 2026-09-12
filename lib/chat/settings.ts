/** What the owner has chosen for the chat surface, and how to read it safely.
 *
 * Stored as one JSON document per owner in `chat_settings`, deliberately not in
 * the workspace blob: that blob is guarded by a revision CAS, and a losing
 * write makes the workspace tab stop saving permanently. See the migration for
 * the full reasoning.
 *
 * Everything here is parsed rather than trusted. The row is written by this
 * app, but a row that predates a field, or one hand-edited in the database, has
 * to produce a usable object rather than a crash on the next run.
 */

// Both of these modules are pure by design. Importing run-agent here instead
// would pull the server's whole tool tree into the browser bundle.
import { DEFAULT_MAX_STEPS, MAX_ALLOWED_STEPS } from '../ai/chat-request.ts';
import { DEFAULT_CONTEXT_CHARACTERS } from '../ai/context.ts';

export type ChatSettings = {
  /** Tools the owner has switched off. Names, not indices, so the list
   * survives a tool being added or removed. */
  disabledTools: string[];
  /** Ceiling on tool-calling rounds for one answer. */
  maxSteps: number;
  /** How much earlier conversation the run may carry, in characters. */
  contextCharacters: number;
  /** Whether the transcript shows the run's own working. */
  showActivity: boolean;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  disabledTools: [],
  maxSteps: DEFAULT_MAX_STEPS,
  contextCharacters: DEFAULT_CONTEXT_CHARACTERS,
  showActivity: true,
};

/** Below this a conversation cannot carry its own previous turn, which makes
 * the setting a way to break the chat rather than tune it. */
const MIN_CONTEXT_CHARACTERS = 2_000;
const MAX_CONTEXT_CHARACTERS = 400_000;
/** A tool list long enough to be a mistake rather than a preference. */
const MAX_DISABLED_TOOLS = 200;
const MAX_TOOL_NAME = 100;

const clamp = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;

/** Normalise whatever was stored into settings a run can be built from. */
export function parseChatSettings(raw: unknown): ChatSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CHAT_SETTINGS };
  const value = raw as Record<string, unknown>;
  return {
    disabledTools: Array.isArray(value.disabledTools)
      ? [
          ...new Set(
            value.disabledTools.filter(
              (tool): tool is string =>
                typeof tool === 'string' && tool.length > 0 && tool.length <= MAX_TOOL_NAME,
            ),
          ),
        ].slice(0, MAX_DISABLED_TOOLS)
      : [],
    maxSteps: clamp(value.maxSteps, 1, MAX_ALLOWED_STEPS, DEFAULT_CHAT_SETTINGS.maxSteps),
    contextCharacters: clamp(
      value.contextCharacters,
      MIN_CONTEXT_CHARACTERS,
      MAX_CONTEXT_CHARACTERS,
      DEFAULT_CHAT_SETTINGS.contextCharacters,
    ),
    // Absent means on: the default is to show the working, and a row written
    // before this field existed should not silently hide it.
    showActivity: value.showActivity !== false,
  };
}

/** Read a stored document, tolerating one that is not JSON at all. */
export function readChatSettings(body: string | null | undefined): ChatSettings {
  if (!body) return { ...DEFAULT_CHAT_SETTINGS };
  try {
    return parseChatSettings(JSON.parse(body));
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

/**
 * Fold an update into the stored settings.
 *
 * A merge rather than a replace, so a client that knows about three fields
 * cannot silently reset a fourth it has never heard of — which is what would
 * happen the first time an older tab saved after an upgrade.
 */
export function mergeChatSettings(current: ChatSettings, update: unknown): ChatSettings {
  if (!update || typeof update !== 'object') return current;
  const value = update as Record<string, unknown>;
  return parseChatSettings({
    ...current,
    ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
  });
}
