/** Reading the two knowledge stores from this deployment's storage.
 *
 * Split from `run-knowledge.ts` so that module stays a pure function of what it
 * is handed, testable without a database — the same split `lib/mcp/app-context`
 * makes for the same reason.
 */

import type { KnowledgeSources } from './run-knowledge.ts';
import { parseKnowledge, type KnowledgeItem } from '../playground/knowledge.ts';
import { createMemoryStore, toKnowledgeItem, type SqliteHandle } from '../memory/store.ts';

export type { SqliteHandle };

export type ObjectStore = { get(key: string): Promise<{ text(): Promise<string> } | null> };

export function createKnowledgeSources(db: SqliteHandle, bucket?: ObjectStore): KnowledgeSources {
  const statements = {
    state: db.prepare('SELECT body FROM workspace_states WHERE user_id = ?'),
    shared: db.prepare('SELECT body FROM shared_knowledge ORDER BY updated_at DESC LIMIT 500'),
  };
  const memories = createMemoryStore(db);
  const sources: KnowledgeSources = {
    /**
     * The person's memories, after a one-time copy of what the blob held.
     *
     * The blob is read whole here — not through the 4 MB guard the run applies
     * to its own reads — because an import that skipped a large blob and then
     * marked itself done would lose everything in it. The marker is written
     * only after the rows landed (see importItems), so a read that throws is
     * retried on the next run rather than recorded as finished.
     */
    async memories(userId) {
      if (!memories.imported(userId)) {
        let items: KnowledgeItem[] = [];
        try {
          const body = await sources.personal(userId);
          if (body) items = parseKnowledge((JSON.parse(body) as { knowledge?: unknown }).knowledge);
        } catch {
          // Unreadable is not the same as empty: leave the marker unwritten so
          // the next run tries again, and answer from the table as it stands.
          return memories.list(userId).map(toKnowledgeItem);
        }
        memories.importItems(userId, items);
      }
      return memories.list(userId).map(toKnowledgeItem);
    },
    async personal(userId) {
      const row = statements.state.get(userId) as { body?: string } | undefined;
      const body = row?.body;
      if (!body) return null;
      // A large workspace is stored as a pointer into the object store rather
      // than inline, so the row may be an envelope rather than the document.
      try {
        const parsed = JSON.parse(body) as { format?: string; key?: string };
        if (parsed?.format === 'hikmah.workspace.object.v1' && parsed.key && bucket) {
          const object = await bucket.get(parsed.key);
          return object ? await object.text() : null;
        }
      } catch {
        return null;
      }
      return body;
    },
    async shared() {
      return (statements.shared.all() as { body: string }[]).map((row) => row.body);
    },
  };
  return sources;
}
