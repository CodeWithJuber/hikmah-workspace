/**
 * Compare-view evidence: folding a run's stream into what the "Why different?"
 * panel can show, and matching reviewed learning examples to the question with
 * the same rule the server uses to inject them (`lib/learning/retrieval.ts`).
 *
 * Pure functions only — no React, no fetch, no DOM — so the panel cannot drift
 * from what a test proves. The browser fold reads the same `UIMessageChunk`
 * stream the run worker writes; it never invents what the run did.
 */
import type { UIMessageChunk } from 'ai';
import { terms as canonicalTerms } from '../text/normalise.ts';
import type { LearningExample } from '../learning/types.ts';

export type EvidenceToolState = 'running' | 'done' | 'error' | 'denied';
export type EvidenceTool = { id: string; name: string; state: EvidenceToolState };
export type EvidenceMemory = { id: string; title: string; kind: string };
export type EvidenceConversation = { id: string; title: string };
export type RunMeta = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LaneFold = {
  /** The answer text accumulated from text-delta chunks. */
  text: string;
  /** Reasoning deltas arrived: the run is thinking rather than writing. */
  thinking: boolean;
  /** Tools the run invoked, in the order their calls opened. */
  tools: EvidenceTool[];
  /** Saved memories the run read, from the worker's data-memories chunk. */
  memories: EvidenceMemory[];
  /** Earlier conversations the run recalled, from the same chunk. */
  conversations: EvidenceConversation[];
  /** What the stream said about the run itself. */
  meta: RunMeta;
  /** A stream-level failure, in the worker's own words. */
  error: string | null;
  /** The person stopped the run. */
  cancelled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEvidenceMemory = (value: unknown): value is EvidenceMemory =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.kind === 'string';

const isEvidenceConversation = (value: unknown): value is EvidenceConversation =>
  isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string';

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Model and token usage from a `start`, `message-metadata` or `finish`
 * chunk. Defensive: the worker writes `{ model, usage }`, and anything else
 * is ignored rather than guessed. */
function pickMeta(metadata: unknown): RunMeta {
  const meta: RunMeta = {};
  if (!isRecord(metadata)) return meta;
  if (typeof metadata.model === 'string' && metadata.model) meta.model = metadata.model;
  if (isRecord(metadata.usage)) {
    const usage = metadata.usage;
    const inputTokens = asCount(usage.inputTokens);
    const outputTokens = asCount(usage.outputTokens);
    const totalTokens = asCount(usage.totalTokens);
    if (inputTokens !== undefined) meta.inputTokens = inputTokens;
    if (outputTokens !== undefined) meta.outputTokens = outputTokens;
    if (totalTokens !== undefined) meta.totalTokens = totalTokens;
  }
  return meta;
}

/**
 * Fold a run's `UIMessageChunk` stream into evidence for the panel.
 *
 * The fold is stateful but the returned `state` object is mutated in place:
 * a caller that renders it throttles its own re-renders, so a provider
 * streaming a hundred chunks a second does not commit a hundred times.
 */
export function createLaneFold(): {
  state: LaneFold;
  apply: (chunk: UIMessageChunk) => void;
} {
  const tools = new Map<string, EvidenceTool>();
  const state: LaneFold = {
    text: '',
    thinking: false,
    tools: [],
    memories: [],
    conversations: [],
    meta: {},
    error: null,
    cancelled: false,
  };
  const syncTools = () => {
    state.tools = [...tools.values()];
  };
  const upsertTool = (id: string, name?: string, toolState?: EvidenceToolState) => {
    const current = tools.get(id);
    tools.set(id, {
      id,
      name: name ?? current?.name ?? 'tool',
      state: toolState ?? current?.state ?? 'running',
    });
    syncTools();
  };
  const apply = (chunk: UIMessageChunk): void => {
    switch (chunk.type) {
      case 'text-delta':
        state.text += chunk.delta;
        break;
      case 'reasoning-delta':
        state.thinking = true;
        break;
      case 'tool-input-start':
        upsertTool(chunk.toolCallId, chunk.toolName, 'running');
        break;
      case 'tool-input-available':
        upsertTool(chunk.toolCallId, chunk.toolName, 'running');
        break;
      case 'tool-output-available':
        upsertTool(chunk.toolCallId, undefined, 'done');
        break;
      case 'tool-output-error':
        upsertTool(chunk.toolCallId, undefined, 'error');
        break;
      case 'tool-output-denied':
        upsertTool(chunk.toolCallId, undefined, 'denied');
        break;
      case 'data-memories': {
        // The worker writes the memories it read right after the message
        // opens: `data: { used, conversations }`. See lib/runs/service.ts.
        const data = (chunk as { data?: unknown }).data;
        if (isRecord(data)) {
          if (Array.isArray(data.used))
            state.memories = data.used.filter(isEvidenceMemory).map((memory) => ({
              id: memory.id,
              title: memory.title,
              kind: memory.kind,
            }));
          if (Array.isArray(data.conversations))
            state.conversations = data.conversations
              .filter(isEvidenceConversation)
              .map((conversation) => ({ id: conversation.id, title: conversation.title }));
        }
        break;
      }
      case 'start':
      case 'message-metadata':
      case 'finish': {
        const metadata = (chunk as { messageMetadata?: unknown }).messageMetadata;
        state.meta = { ...state.meta, ...pickMeta(metadata) };
        break;
      }
      case 'error':
        state.error = chunk.errorText;
        break;
      case 'abort':
        state.cancelled = true;
        break;
      default:
        break;
    }
  };
  return { state, apply };
}

// --- Reviewed-example matching ------------------------------------------------

/** Copied verbatim from lib/learning/retrieval.ts: the filter on top of the
 * canonical tokeniser is a vocabulary choice, not a normalisation one, and
 * the client must score exactly what the server scores. */
const STOP = new Set(
  'a an and are as at be by can do for from how i in is it me my of on or our please that the their this to us was we what when where which with you your'.split(
    ' ',
  ),
);

const terms = (text: string): Set<string> =>
  new Set([...canonicalTerms(text)].filter((term) => term.length >= 2 && !STOP.has(term)));

/**
 * Which of the person's *reviewed* examples the server would have injected
 * for this question. The same bound as the server: lexical overlap
 * (shared >= 2, score >= 0.12), best three. A match is an example to review,
 * not evidence that the model or its answer is correct.
 */
export function matchLearningExamples(
  query: string,
  examples: readonly LearningExample[],
): LearningExample[] {
  const words = terms(query);
  if (!words.size) return [];
  return examples
    .filter((item) => item.status === 'approved')
    .map((item) => {
      const other = terms(item.prompt);
      const shared = [...words].filter((word) => other.has(word)).length;
      return { item, shared, score: shared / Math.max(1, words.size + other.size - shared) };
    })
    .filter((match) => match.shared >= 2 && match.score >= 0.12)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .slice(0, 3)
    .map((match) => match.item);
}
