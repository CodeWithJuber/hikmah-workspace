/** The memories table, over raw node:sqlite.
 *
 * Raw prepared statements like lib/runs/store.ts and lib/context-model/
 * candidate-store.ts, for the same reasons: this is read on the request path
 * behind every chat message and the D1-shaped shim discards the rows an
 * UPSERT returns. Every method is total — a store that cannot be read is a
 * lookup that finds nothing, never a message that did not send.
 */
import { randomUUID } from 'node:crypto';
import { PROVENANCES, type KnowledgeItem, type Provenance } from '../playground/knowledge.ts';
import { contentKey } from '../text/normalise.ts';

/** The subset of node:sqlite this needs. */
export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

export type MemoryStatus = 'suggested' | 'saved' | 'rejected';
export type MemoryKind = 'preference' | 'reference' | 'episode';

export type Memory = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: Provenance;
  source: string;
  sourceConversationId: string | null;
  status: MemoryStatus;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  uses: number;
};

export type NewMemory = {
  id?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: Provenance;
  source?: string;
  sourceConversationId?: string | null;
  status: MemoryStatus;
  enabled?: boolean;
};

/** The limits the blob's parser enforced, kept so the two stores agree. */
const LIMITS = { title: 120, content: 12000, source: 300, perUser: 500 } as const;

type Row = {
  id: string;
  kind: string;
  title: string;
  content: string;
  provenance: string;
  source: string;
  source_conversation_id: string | null;
  status: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  uses: number;
};

const KINDS = new Set<string>(['preference', 'reference', 'episode']);
const STATUSES = new Set<string>(['suggested', 'saved', 'rejected']);

function fromRow(row: Row): Memory {
  return {
    id: row.id,
    kind: (KINDS.has(row.kind) ? row.kind : 'reference') as MemoryKind,
    title: row.title,
    content: row.content,
    provenance: (PROVENANCES as readonly string[]).includes(row.provenance)
      ? (row.provenance as Provenance)
      : 'quote',
    source: row.source,
    sourceConversationId: row.source_conversation_id,
    status: (STATUSES.has(row.status) ? row.status : 'suggested') as MemoryStatus,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    uses: Number(row.uses) || 0,
  };
}

/** A memory in the shape the retrieval takes. `episode` is a reference for
 * ranking purposes: it is retrieved by its terms, never sent unconditionally. */
export function toKnowledgeItem(memory: Memory): KnowledgeItem {
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    kind: memory.kind === 'preference' ? 'preference' : 'reference',
    provenance: memory.provenance,
    uses: memory.uses,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    enabled: memory.enabled,
    status: memory.status === 'saved' ? 'saved' : 'suggested',
  };
}

const clip = (value: unknown, max: number) =>
  (typeof value === 'string' ? value : '').slice(0, max);

export function createMemoryStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  // Prepared on first use, not at construction, and a failure to prepare is a
  // missing table rather than a failed request. See candidate-store.ts.
  const cache = new Map<string, ReturnType<SqliteHandle['prepare']> | null>();
  const prepare = (sql: string) => {
    if (!cache.has(sql)) {
      try {
        cache.set(sql, db.prepare(sql));
      } catch {
        cache.set(sql, null);
      }
    }
    return cache.get(sql) ?? null;
  };

  const sql = {
    insert: `INSERT INTO memories
        (id, user_id, kind, title, content, content_key, provenance, source,
         source_conversation_id, status, enabled, created_at, updated_at, uses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (user_id, kind, content_key) DO UPDATE SET
        uses = uses + 1,
        updated_at = excluded.updated_at
      RETURNING id, (uses = 0) AS created`,
    // Import: the person's own id from the blob wins, and a second import of
    // the same id or the same text is silently nothing.
    importRow: `INSERT OR IGNORE INTO memories
        (id, user_id, kind, title, content, content_key, provenance, source,
         source_conversation_id, status, enabled, created_at, updated_at, uses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)`,
    list: `SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
    listByStatus: `SELECT * FROM memories WHERE user_id = ? AND status = ?
      ORDER BY updated_at DESC, id LIMIT ?`,
    get: `SELECT * FROM memories WHERE user_id = ? AND id = ?`,
    count: `SELECT COUNT(*) AS n FROM memories WHERE user_id = ?`,
    counts: `SELECT status, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY status`,
    toReview: `SELECT COUNT(*) AS n FROM memories
      WHERE user_id = ? AND source_conversation_id = ? AND status = 'suggested'`,
    update: `UPDATE memories SET title = ?, content = ?, content_key = ?, kind = ?,
        status = ?, enabled = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
    remove: `DELETE FROM memories WHERE user_id = ? AND id = ?`,
    used: `UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE user_id = ? AND id = ?`,
    recent: `SELECT * FROM memories WHERE user_id = ? AND last_used_at IS NOT NULL
      ORDER BY last_used_at DESC LIMIT ?`,
    imported: `SELECT imported FROM memory_imports WHERE user_id = ?`,
    markImported: `INSERT INTO memory_imports (user_id, imported_at, imported) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET imported_at = excluded.imported_at, imported = excluded.imported`,
  };

  return {
    /**
     * Save a memory, or count it again if the same text is already there.
     *
     * Returns the row's id and whether it was new. The same preference saved
     * every morning is one row with a rising count, not a queue of copies —
     * and the count is what decides which preferences travel.
     */
    add(userId: string, input: NewMemory): { id: string; created: boolean } | null {
      const statement = prepare(sql.insert);
      if (!statement) return null;
      const content = clip(input.content, LIMITS.content).trim();
      if (!content) return null;
      const stamp = now();
      try {
        if (Number(this.count(userId)) >= LIMITS.perUser) return null;
        const row = statement.get(
          input.id ?? 'mem_' + randomUUID(),
          userId,
          KINDS.has(input.kind) ? input.kind : 'reference',
          clip(input.title, LIMITS.title) || content.slice(0, 75),
          content,
          contentKey(content),
          (PROVENANCES as readonly string[]).includes(input.provenance)
            ? input.provenance
            : 'inference',
          clip(input.source ?? '', LIMITS.source),
          input.sourceConversationId ?? null,
          STATUSES.has(input.status) ? input.status : 'suggested',
          input.enabled === false ? 0 : 1,
          stamp,
          stamp,
        ) as { id: string; created: number } | undefined;
        return row ? { id: row.id, created: row.created === 1 } : null;
      } catch {
        return null;
      }
    },

    /** The person's memories, newest first; optionally one status only. */
    list(userId: string, options: { status?: MemoryStatus; limit?: number } = {}): Memory[] {
      const limit = Math.max(1, Math.min(LIMITS.perUser, options.limit ?? LIMITS.perUser));
      try {
        const rows = options.status
          ? prepare(sql.listByStatus)?.all(userId, options.status, limit)
          : prepare(sql.list)?.all(userId, limit);
        return ((rows ?? []) as Row[]).map(fromRow);
      } catch {
        return [];
      }
    },

    get(userId: string, id: string): Memory | null {
      try {
        const row = prepare(sql.get)?.get(userId, id) as Row | undefined;
        return row ? fromRow(row) : null;
      } catch {
        return null;
      }
    },

    count(userId: string): number {
      try {
        return Number((prepare(sql.count)?.get(userId) as { n: number } | undefined)?.n ?? 0);
      } catch {
        return 0;
      }
    },

    /** How many are saved and how many wait, so a screen can say so. */
    counts(userId: string): Record<MemoryStatus, number> {
      const out: Record<MemoryStatus, number> = { suggested: 0, saved: 0, rejected: 0 };
      try {
        for (const row of (prepare(sql.counts)?.all(userId) ?? []) as {
          status: string;
          n: number;
        }[])
          if (STATUSES.has(row.status)) out[row.status as MemoryStatus] = Number(row.n);
      } catch {
        /* nothing waiting that can be counted */
      }
      return out;
    },

    /** How many a conversation (a finished task, say) left waiting for review. */
    toReview(userId: string, conversationId: string): number {
      try {
        return Number(
          (prepare(sql.toReview)?.get(userId, conversationId) as { n: number } | undefined)?.n ?? 0,
        );
      } catch {
        return 0;
      }
    },

    /**
     * Change one memory: accept it, edit it, switch it off, or reject it.
     *
     * Returns the row as it now is, or null when it is not this person's or
     * the edit would make it a duplicate of another row — which is refused
     * rather than merged, because two memories the person wrote differently
     * are theirs to reconcile.
     */
    update(
      userId: string,
      id: string,
      patch: Partial<Pick<Memory, 'title' | 'content' | 'kind' | 'status' | 'enabled'>>,
    ): Memory | null {
      const current = this.get(userId, id);
      if (!current) return null;
      const content = clip(patch.content ?? current.content, LIMITS.content).trim();
      if (!content) return null;
      const next = {
        title: clip(patch.title ?? current.title, LIMITS.title) || content.slice(0, 75),
        content,
        kind: patch.kind && KINDS.has(patch.kind) ? patch.kind : current.kind,
        status: patch.status && STATUSES.has(patch.status) ? patch.status : current.status,
        enabled: patch.enabled ?? current.enabled,
      };
      try {
        prepare(sql.update)?.run(
          next.title,
          next.content,
          contentKey(next.content),
          next.kind,
          next.status,
          next.enabled ? 1 : 0,
          now(),
          userId,
          id,
        );
      } catch {
        return null;
      }
      return this.get(userId, id);
    },

    remove(userId: string, id: string): boolean {
      try {
        const result = prepare(sql.remove)?.run(userId, id) as { changes?: number } | undefined;
        return Number(result?.changes ?? 0) > 0;
      } catch {
        return false;
      }
    },

    /** An answer drew on these. Counted so the most used preferences travel,
     * and dated so the screen can show what was used last. */
    markUsed(userId: string, ids: readonly string[]): void {
      const stamp = now();
      for (const id of ids)
        try {
          prepare(sql.used)?.run(stamp, userId, id);
        } catch {
          /* a count that did not move is not worth a failed answer */
        }
    },

    recentlyUsed(userId: string, limit = 8): Memory[] {
      try {
        return ((prepare(sql.recent)?.all(userId, Math.max(1, limit)) ?? []) as Row[]).map(fromRow);
      } catch {
        return [];
      }
    },

    /** Whether the blob's knowledge has already been copied in for this person. */
    imported(userId: string): boolean {
      try {
        return !!prepare(sql.imported)?.get(userId);
      } catch {
        return false;
      }
    },

    /**
     * Copy the blob's items in, keeping their ids, and mark the person done.
     *
     * Marked only after the rows were written: an import that threw is retried
     * next time rather than recorded as finished with nothing in it. An empty
     * blob is a finished import too — there is nothing to retry.
     */
    importItems(userId: string, items: readonly KnowledgeItem[]): number {
      const statement = prepare(sql.importRow);
      const mark = prepare(sql.markImported);
      if (!statement || !mark) return 0;
      let written = 0;
      for (const item of items) {
        try {
          const result = statement.run(
            item.id,
            userId,
            item.kind,
            clip(item.title, LIMITS.title) || item.content.slice(0, 75),
            clip(item.content, LIMITS.content),
            contentKey(item.content),
            // They typed every one of these, so they are the person's own words.
            item.provenance ?? 'quote',
            clip(item.source, LIMITS.source),
            item.status === 'suggested' ? 'suggested' : 'saved',
            item.enabled === false ? 0 : 1,
            item.createdAt || now(),
            item.updatedAt || now(),
          ) as { changes?: number } | undefined;
          written += Number(result?.changes ?? 0);
        } catch {
          /* one unwritable item does not stop the rest */
        }
      }
      try {
        mark.run(userId, now(), written);
      } catch {
        /* unmarked means retried, which is the safe side */
      }
      return written;
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
