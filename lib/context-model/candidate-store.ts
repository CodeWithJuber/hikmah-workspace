/** The queue of sentences from the owner's chats worth annotating.
 *
 * Raw node:sqlite, like lib/runs/store.ts and for the same reasons: this is
 * written on the request path behind every chat message, so re-preparing a
 * statement per call is a cost paid per turn, and the D1-shaped shim discards
 * the rows an UPSERT returns.
 *
 * Every method is total. Collection happens beside a person's message and must
 * never be able to fail it: a queue that cannot be written is a feature that
 * did not happen, not a conversation that did not send.
 */
import { uncertainty, type Candidate } from './candidates.ts';
import { DEFAULT_LEARNING_POLICY } from '../learning/types.ts';

/** The subset of node:sqlite this needs. */
export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

/**
 * How many unreviewed sentences one owner keeps per language.
 *
 * A bound rather than a policy: this grows by a few rows per message and
 * nothing deletes it but review, so without one a year of chat is a table
 * nobody reads. When it is full the *easiest* rows are dropped, because the
 * queue exists to hold the hardest — an easy sentence displaced by a harder one
 * has lost nothing worth keeping.
 */
export const MAX_QUEUED = 400;

export type QueuedCandidate = {
  language: string;
  text: string;
  fingerprint: string;
  uncertainty: number;
  tokens: number;
  annotation: unknown;
  created_at: string;
};

export function createCandidateStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  /**
   * Prepared on first use, not at construction.
   *
   * `prepare` throws when the table is not there, and this store is built
   * inside the request that sends a chat message — so on a deployment that has
   * not applied the migration yet, eager preparation would throw before a
   * single try/catch below could see it and every message would fail on a
   * feature nobody asked for. Lazy, cached, and a failure to prepare is a
   * missing queue rather than a missing conversation.
   */
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
    retention: 'SELECT retention_days FROM learning_policies WHERE user_id = ?',
    expired: 'DELETE FROM context_candidates WHERE user_id = ? AND created_at < ?',
    // Last writer wins on the parse: a later turn was parsed by whatever
    // checkpoint is active now, which is the more useful starting point. The
    // review flag is deliberately not reset — a sentence dealt with stays
    // dealt with, or the same one returns every time it is mentioned.
    upsert: `INSERT INTO context_candidates
         (user_id, language, fingerprint, text, annotation, uncertainty, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, language, fingerprint) DO UPDATE SET
         annotation = excluded.annotation,
         uncertainty = excluded.uncertainty,
         tokens = excluded.tokens`,
    queue: `SELECT language, text, fingerprint, uncertainty, tokens, annotation, created_at
         FROM context_candidates
        WHERE user_id = ? AND language = ? AND reviewed_at IS NULL
        ORDER BY uncertainty DESC, created_at
        LIMIT ?`,
    counts: `SELECT language, COUNT(*) AS waiting
         FROM context_candidates
        WHERE user_id = ? AND reviewed_at IS NULL
        GROUP BY language`,
    review: `UPDATE context_candidates SET reviewed_at = ?
        WHERE user_id = ? AND language = ? AND fingerprint = ?`,
    // Keep the hardest MAX_QUEUED and drop the rest.
    trim: `DELETE FROM context_candidates
        WHERE user_id = ? AND language = ? AND reviewed_at IS NULL
          AND fingerprint NOT IN (
            SELECT fingerprint FROM context_candidates
             WHERE user_id = ? AND language = ? AND reviewed_at IS NULL
             ORDER BY uncertainty DESC, created_at
             LIMIT ?
          )`,
  };

  // Enforce retention even when the owner opens the co-model directly and
  // never visits the exchange queue. Older schemas use the safe default.
  const purge = (userId: string) => {
    const row = prepare(sql.retention)?.get(userId) as { retention_days?: number } | undefined;
    const days =
      row?.retention_days && [7, 30, 90].includes(row.retention_days)
        ? row.retention_days
        : DEFAULT_LEARNING_POLICY.retentionDays;
    const cutoff = new Date(Date.parse(now()) - days * 86_400_000).toISOString();
    prepare(sql.expired)?.run(userId, cutoff);
  };

  return {
    /** Record what this turn found hard. Returns how many rows were written. */
    record(userId: string, candidates: readonly Candidate[]): number {
      try {
        purge(userId);
      } catch {
        return 0;
      }
      // No statement means no table, which means nothing was recorded — saying
      // otherwise would report a queue that does not exist.
      const upsert = prepare(sql.upsert);
      if (!upsert) return 0;
      let written = 0;
      const languages = new Set<string>();
      const stamp = now();
      for (const candidate of candidates) {
        try {
          upsert.run(
            userId,
            candidate.language,
            candidate.fingerprint,
            candidate.text,
            JSON.stringify(candidate.annotation),
            uncertainty(candidate),
            candidate.tokens,
            stamp,
          );
          languages.add(candidate.language);
          written++;
        } catch {
          // One unwritable row is not a reason to lose the others, and none of
          // it is a reason to fail the message this rode in on.
        }
      }
      for (const language of languages)
        try {
          prepare(sql.trim)?.run(userId, language, userId, language, MAX_QUEUED);
        } catch {
          /* a queue that could not be trimmed is still a usable queue */
        }
      return written;
    },

    /** The hardest unreviewed sentences for one language. */
    queue(userId: string, language: string, limit = 20): QueuedCandidate[] {
      try {
        purge(userId);
        return (
          (prepare(sql.queue)?.all(userId, language, Math.max(1, Math.min(500, limit))) as
            (Omit<QueuedCandidate, 'annotation'> & { annotation: string })[] | undefined) ?? []
        ).map((row) => ({ ...row, annotation: JSON.parse(row.annotation) }));
      } catch {
        return [];
      }
    },

    /** How many are waiting, per language, so the screen can say so. */
    waiting(userId: string): Record<string, number> {
      try {
        purge(userId);
        const rows = (prepare(sql.counts)?.all(userId) ?? []) as {
          language: string;
          waiting: number;
        }[];
        return Object.fromEntries(rows.map((row) => [row.language, Number(row.waiting)]));
      } catch {
        return {};
      }
    },

    /** Mark sentences dealt with, so the queue does not offer them again. */
    reviewed(userId: string, language: string, fingerprints: readonly string[]): number {
      try {
        purge(userId);
      } catch {
        return 0;
      }
      const stamp = now();
      let marked = 0;
      for (const fingerprint of fingerprints)
        try {
          prepare(sql.review)?.run(stamp, userId, language, fingerprint);
          marked++;
        } catch {
          /* nothing to do about one row that will not update */
        }
      return marked;
    },
  };
}

export type CandidateStore = ReturnType<typeof createCandidateStore>;
