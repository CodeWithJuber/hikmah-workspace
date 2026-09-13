/** Reading the two knowledge stores from this deployment's storage.
 *
 * Split from `run-knowledge.ts` so that module stays a pure function of what it
 * is handed, testable without a database — the same split `lib/mcp/app-context`
 * makes for the same reason.
 */

import type { KnowledgeSources } from './run-knowledge.ts';

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export type ObjectStore = { get(key: string): Promise<{ text(): Promise<string> } | null> };

export function createKnowledgeSources(db: SqliteHandle, bucket?: ObjectStore): KnowledgeSources {
  const statements = {
    state: db.prepare('SELECT body FROM workspace_states WHERE user_id = ?'),
    shared: db.prepare('SELECT body FROM shared_knowledge ORDER BY updated_at DESC LIMIT 500'),
  };
  return {
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
}
