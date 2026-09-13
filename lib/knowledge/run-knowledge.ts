/** The owner's saved knowledge, for one run.
 *
 * `retrieveKnowledge` and `knowledgePrompt` in `lib/playground/knowledge.ts`
 * are complete, tested, and were called by exactly one thing:
 * `components/playground/chat.tsx:765,780`, the browser run loop. When that was
 * deleted they kept their tests and lost their only caller, so the Memory
 * screen went on saving items, the retrieval mathematics went on being correct,
 * and no answer has used one since. Same failure as the co-model, found by the
 * same reachability walk.
 *
 * This is the server-side half: read both stores, ask the existing retrieval
 * which items are relevant, and hand back the block it already knows how to
 * build. The scoring, the budget and the untrusted-data framing are not
 * reimplemented here — they were never the broken part.
 */

import {
  knowledgePrompt,
  parseKnowledge,
  retrieveKnowledge,
  type KnowledgeItem,
} from '../playground/knowledge.ts';

/** Guard against parsing a workspace blob that is mostly conversation history.
 * The envelope is capped at 24 MB, and a run should not spend that on a lookup
 * whose whole output is bounded at 8,000 characters. */
const MAX_BLOB_BYTES = 4_000_000;
/** How many published items to consider. The retrieval takes at most eight. */
const MAX_SHARED = 500;

export type KnowledgeSources = {
  /** Reads `workspace_states.body` for this owner, or null. */
  personal(userId: string): Promise<string | null>;
  /** Reads every published `shared_knowledge` row. */
  shared(): Promise<string[]>;
};

/**
 * Both stores, merged, with anything unreadable simply absent.
 *
 * Personal knowledge still lives in the workspace blob, which
 * `docs/architecture.md` records as one of the two things keeping that blob
 * alive. Reading it here does not fix that; it means the feature works while it
 * is still true.
 */
export async function collectKnowledge(
  sources: KnowledgeSources,
  userId: string,
): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];

  try {
    const body = await sources.personal(userId);
    if (body && body.length <= MAX_BLOB_BYTES) {
      const parsed = JSON.parse(body) as { knowledge?: unknown };
      items.push(...parseKnowledge(parsed.knowledge));
    }
  } catch {
    /* a blob this run cannot read is a lookup that finds nothing, not a failure */
  }

  try {
    for (const row of (await sources.shared()).slice(0, MAX_SHARED)) {
      try {
        items.push(...parseKnowledge([JSON.parse(row)]));
      } catch {
        /* one malformed published row must not cost the other 499 */
      }
    }
  } catch {
    /* likewise */
  }

  // One id wins once. A published copy of a personal item would otherwise be
  // retrieved twice and spend the budget saying the same thing.
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

/**
 * The block for this turn, or ''.
 *
 * Never throws: knowledge is an aid to an answer, and a lookup that fails must
 * cost the aid rather than the answer.
 */
export async function knowledgeForRun(options: {
  sources: KnowledgeSources;
  userId: string;
  /** What the person just asked. References must share a term with it;
   * preferences are included regardless, which is the existing rule. */
  query: string;
}): Promise<string> {
  if (!options.query.trim()) return '';
  try {
    const items = await collectKnowledge(options.sources, options.userId);
    if (!items.length) return '';
    return knowledgePrompt(retrieveKnowledge(items, options.query));
  } catch {
    return '';
  }
}
