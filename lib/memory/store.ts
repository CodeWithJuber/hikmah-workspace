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

/** A scope names the project/workspace a memory belongs to. 'global' travels
 * with every answer; any other scope is recalled only when that scope is
 * asked for, so a fact learned in project A never leaks into project B. The
 * convention is `project:<id>` or `workspace:<id>`, but the store treats it
 * as an opaque validated string. */
export type MemoryScope = string;
export const GLOBAL_SCOPE = 'global';

const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/;

/** Scopes come from callers and are stored in SQL: validate the shape, and
 * fall back to global rather than storing something surprising. */
export function normalizeScope(scope: unknown): MemoryScope {
  return typeof scope === 'string' && SCOPE_PATTERN.test(scope) ? scope : GLOBAL_SCOPE;
}

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
  /** The id of the memory this row corrects, or null. A correction is a new
   * row linked to the old one — the old row is never edited in place, so the
   * history survives and recall prefers the newer fact. */
  supersedes: string | null;
  /** ISO timestamp after which the row is no longer recalled, or null when
   * the memory does not expire. */
  expiresAt: string | null;
  scope: MemoryScope;
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
  supersedes?: string | null;
  expiresAt?: string | null;
  scope?: string;
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
  supersedes: string | null;
  expires_at: string | null;
  scope: string | null;
};

const KINDS = new Set<string>(['preference', 'reference', 'episode']);
const STATUSES = new Set<string>(['suggested', 'saved', 'rejected']);

const asIdOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : null;

const asTimestampOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/** An expiry timestamp for a memory, normalised to ISO, or null when the
 * input is absent or not a timestamp. Callers decide whether null from
 * invalid input is a 400 or a default. */
export const normalizeExpiresAt = (value: unknown): string | null => asTimestampOrNull(value);

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
    supersedes: asIdOrNull(row.supersedes),
    expiresAt: asTimestampOrNull(row.expires_at),
    scope: normalizeScope(row.scope),
  };
}

/** A memory in the shape the retrieval takes. `episode` is a reference for
 * ranking purposes: it is retrieved by its terms, never sent unconditionally.
 * Expiry and scope travel with it so the ranking can gate on them. */
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
    ...(memory.expiresAt ? { expiresAt: memory.expiresAt } : {}),
    scope: memory.scope,
  };
}

const clip = (value: unknown, max: number) =>
  (typeof value === 'string' ? value : '').slice(0, max);

/** True when the memory's expiry has passed. Expiry is a hard gate for
 * recall; mere age is only a ranking decay. */
export function isExpired(
  memory: Pick<Memory, 'expiresAt'>,
  at: string = new Date().toISOString(),
): boolean {
  return !!memory.expiresAt && memory.expiresAt <= at;
}

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
         source_conversation_id, status, enabled, created_at, updated_at, uses,
         supersedes, expires_at, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (user_id, scope, kind, content_key) DO UPDATE SET
        uses = uses + 1,
        updated_at = excluded.updated_at
      RETURNING id, (uses = 0) AS created`,
    // Import: the person's own id from the blob wins, and a second import of
    // the same id or the same text is silently nothing. Blob items predate
    // scopes; they land in the global scope.
    importRow: `INSERT OR IGNORE INTO memories
        (id, user_id, kind, title, content, content_key, provenance, source,
         source_conversation_id, status, enabled, created_at, updated_at, uses,
         supersedes, expires_at, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 'global')`,
    list: `SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
    listByStatus: `SELECT * FROM memories WHERE user_id = ? AND status = ?
      ORDER BY updated_at DESC, id LIMIT ?`,
    listByScope: `SELECT * FROM memories WHERE user_id = ? AND scope = ?
      ORDER BY updated_at DESC, id LIMIT ?`,
    listByScopeStatus: `SELECT * FROM memories WHERE user_id = ? AND scope = ? AND status = ?
      ORDER BY updated_at DESC, id LIMIT ?`,
    get: `SELECT * FROM memories WHERE user_id = ? AND id = ?`,
    count: `SELECT COUNT(*) AS n FROM memories WHERE user_id = ?`,
    counts: `SELECT status, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY status`,
    toReview: `SELECT COUNT(*) AS n FROM memories
      WHERE user_id = ? AND source_conversation_id = ? AND status = 'suggested'`,
    update: `UPDATE memories SET title = ?, content = ?, content_key = ?, kind = ?,
        status = ?, enabled = ?, updated_at = ?, expires_at = ?, scope = ?
      WHERE user_id = ? AND id = ?`,
    remove: `DELETE FROM memories WHERE user_id = ? AND id = ?`,
    used: `UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE user_id = ? AND id = ?`,
    recent: `SELECT * FROM memories WHERE user_id = ? AND last_used_at IS NOT NULL
      ORDER BY last_used_at DESC LIMIT ?`,
    /** Everything recall may consider: enabled, accepted, unexpired, in the
     * requested scope or the global one. Superseded rows are filtered in
     * code, where the chain can be walked without another round trip. */
    recallCandidates: `SELECT * FROM memories
      WHERE user_id = ? AND enabled = 1 AND status = 'saved'
        AND (scope = 'global' OR scope = ?)
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, id LIMIT ?`,
    /** Live rows that correct the given memory: the raw material for both
     * the supersede filter and the conflict listing. */
    correctionsOf: `SELECT * FROM memories
      WHERE user_id = ? AND supersedes = ? AND enabled = 1
        AND (expires_at IS NULL OR expires_at > ?)`,
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
          asIdOrNull(input.supersedes),
          asTimestampOrNull(input.expiresAt),
          normalizeScope(input.scope),
        ) as { id: string; created: number } | undefined;
        return row ? { id: row.id, created: row.created === 1 } : null;
      } catch {
        return null;
      }
    },

    /**
     * Remember a correction: the user corrected the assistant, and the
     * corrected fact must stick — remembered and applied going forward, not
     * re-asked next session.
     *
     * The correction is a NEW row linked to the old one via `supersedes`;
     * the old row is never edited in place, so the history survives. Recall
     * (`forRecall`) drops any row a live row corrects, so the outdated fact
     * cannot override the newer one. A correction always lives in the same
     * scope as what it corrects — a correction that changed scope would be a
     * different fact, and scopes must not leak.
     *
     * Returns the new row's id, whether it was new, and the ids of any OTHER
     * live corrections of the same memory: two live corrections disagree, and
     * that conflict is surfaced (see `conflicts`) rather than hidden. Null
     * when the corrected memory is not this person's, or the store failed.
     */
    addCorrection(
      userId: string,
      supersedesId: string,
      input: NewMemory,
    ): { id: string; created: boolean; conflicts: string[] } | null {
      const target = this.get(userId, supersedesId);
      if (!target) return null;
      const added = this.add(userId, {
        ...input,
        scope: target.scope,
        supersedes: target.id,
      });
      if (!added) return null;
      const conflicts = this.liveCorrectionsOf(userId, target.id, now())
        .map((memory) => memory.id)
        .filter((id) => id !== added.id);
      return { ...added, conflicts };
    },

    /** Live (enabled, unexpired) rows correcting the given memory, newest first. */
    liveCorrectionsOf(userId: string, memoryId: string, at: string = now()): Memory[] {
      try {
        const rows = (prepare(sql.correctionsOf)?.all(userId, memoryId, at) ?? []) as Row[];
        return rows.map(fromRow);
      } catch {
        return [];
      }
    },

    /**
     * Memories with two or more live corrections: the person (or the model)
     * corrected the same fact twice and the corrections disagree. Each entry
     * names the corrected memory and the corrections that conflict over it,
     * so the person can resolve what code must not decide alone.
     */
    conflicts(userId: string, at: string = now()): { memory: Memory; correctedBy: Memory[] }[] {
      try {
        const rows = (prepare(sql.list)?.all(userId, LIMITS.perUser) ?? []) as Row[];
        const memories = rows.map(fromRow);
        const byTarget = new Map<string, Memory[]>();
        for (const memory of memories) {
          if (!memory.supersedes || !memory.enabled || isExpired(memory, at)) continue;
          const group = byTarget.get(memory.supersedes) ?? [];
          group.push(memory);
          byTarget.set(memory.supersedes, group);
        }
        const out: { memory: Memory; correctedBy: Memory[] }[] = [];
        for (const [targetId, corrections] of byTarget) {
          if (corrections.length < 2) continue;
          const target = memories.find((memory) => memory.id === targetId);
          if (target) out.push({ memory: target, correctedBy: corrections });
        }
        return out;
      } catch {
        return [];
      }
    },

    /**
     * The memories one answer may draw on: enabled, accepted, unexpired, and
     * not corrected by a live row — in the requested scope plus the global
     * scope, so a fact learned in project A never leaks into project B while
     * the person's general preferences still travel.
     *
     * A deleted memory simply stops appearing: a recall built before the
     * delete keeps the rows it already read, but every new recall re-reads.
     * `markUsed` on a deleted id updates zero rows and stays silent.
     */
    forRecall(
      userId: string,
      options: { scope?: string; now?: string; limit?: number } = {},
    ): Memory[] {
      const at = options.now ?? now();
      const scope = normalizeScope(options.scope);
      const limit = Math.max(1, Math.min(LIMITS.perUser, options.limit ?? LIMITS.perUser));
      try {
        const rows = (prepare(sql.recallCandidates)?.all(userId, scope, at, limit) ?? []) as Row[];
        const candidates = rows.map(fromRow);
        // Every id a live row corrects. One pass covers chains: when B
        // corrects A and C corrects B, the pass adds both A and B, so only C
        // — the live head — is recalled. A corrector that is itself disabled
        // or expired is not among the candidates, so what it corrected
        // becomes recallable again: the correction is gone, the fact stands.
        const corrected = new Set<string>();
        for (const memory of candidates) if (memory.supersedes) corrected.add(memory.supersedes);
        return candidates.filter((memory) => !corrected.has(memory.id));
      } catch {
        return [];
      }
    },

    /** The person's memories, newest first; optionally one status and/or one
     * scope only. This is the full history — superseded and expired rows are
     * still theirs to see. Retrieval uses `forRecall`, which filters. */
    list(
      userId: string,
      options: { status?: MemoryStatus; scope?: string; limit?: number } = {},
    ): Memory[] {
      const limit = Math.max(1, Math.min(LIMITS.perUser, options.limit ?? LIMITS.perUser));
      try {
        const scope = options.scope === undefined ? undefined : normalizeScope(options.scope);
        const rows =
          scope !== undefined && options.status
            ? prepare(sql.listByScopeStatus)?.all(userId, scope, options.status, limit)
            : scope !== undefined
              ? prepare(sql.listByScope)?.all(userId, scope, limit)
              : options.status
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
      patch: Partial<
        Pick<Memory, 'title' | 'content' | 'kind' | 'status' | 'enabled' | 'expiresAt' | 'scope'>
      >,
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
        expiresAt:
          patch.expiresAt === undefined ? current.expiresAt : asTimestampOrNull(patch.expiresAt),
        scope: patch.scope === undefined ? current.scope : normalizeScope(patch.scope),
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
          next.expiresAt,
          next.scope,
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
