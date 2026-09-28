/** Chat v2 read-only conversation shares.
 *
 * The plaintext token is returned to the caller exactly once and never stored:
 * the row holds only its sha256, so a database read cannot mint a working
 * link. The token is 32 random bytes in base64url (43 characters), unguessable
 * by construction.
 *
 * Raw node:sqlite for the same reason `lib/runs/store.ts` uses it: this module
 * imports nothing from Next, so it can be exercised without a server.
 */

import { createHash, randomBytes } from 'node:crypto';

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: unknown };
  };
  exec(sql: string): void;
};

export type ShareRow = {
  token_hash: string;
  conversation_id: string;
  user_id: string;
  created_at: string;
  revoked_at: string | null;
};

/** 32 bytes → 43 base64url characters, no padding, safe to put in a URL path. */
export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a token. Comparing hashes, never plaintext. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSharesStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO conversation_shares (token_hash, conversation_id, user_id, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ),
    byHash: db.prepare(
      'SELECT * FROM conversation_shares WHERE token_hash = ? AND revoked_at IS NULL',
    ),
    revoke: db.prepare(
      'UPDATE conversation_shares SET revoked_at = ? WHERE conversation_id = ? AND user_id = ? AND revoked_at IS NULL',
    ),
    listForUser: db.prepare(
      `SELECT token_hash, conversation_id, user_id, created_at, revoked_at
       FROM conversation_shares
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    ),
  };

  return {
    /** Create a share link. Returns the plaintext token exactly once — the
     * database never sees it, so this is the only chance to hand it out. */
    createShare(conversationId: string, userId: string): { token: string; createdAt: string } {
      const token = newShareToken();
      const createdAt = now();
      statements.insert.run(hashShareToken(token), conversationId, userId, createdAt);
      return { token, createdAt };
    },

    /** The latest active share for this conversation, if the owner already
     * made one. The plaintext token is gone by design, so what comes back is
     * the link metadata — enough to show "already shared" without minting a
     * second link. */
    activeShare(
      conversationId: string,
      userId: string,
    ): Pick<ShareRow, 'conversation_id' | 'created_at'> | null {
      const row = (
        statements.listForUser.all(userId) as Array<
          Pick<ShareRow, 'conversation_id' | 'created_at' | 'revoked_at'>
        >
      ).find((share) => share.conversation_id === conversationId && share.revoked_at === null);
      return row ? { conversation_id: row.conversation_id, created_at: row.created_at } : null;
    },

    /** Revoke every active share on this conversation. True when something
     * was actually revoked. */
    revokeShare(conversationId: string, userId: string): boolean {
      const result = statements.revoke.run(now(), conversationId, userId);
      return Number(result.changes) > 0;
    },

    /** The owner's shares, active and revoked, newest first. The hashes are
     * useless without the plaintext tokens, so returning them here does not
     * mint working links. */
    listShares(userId: string): ShareRow[] {
      return statements.listForUser.all(userId) as ShareRow[];
    },

    /** Resolve a presented token to what it may read. Null for an unknown
     * token, a revoked one, or anything that is not a token-shaped string —
     * checked in constant time by construction of the lookup, and by hash
     * compare only, never by stored plaintext. */
    resolveToken(token: string): { conversation_id: string; user_id: string } | null {
      if (!token || typeof token !== 'string' || token.length > 128) return null;
      const row = statements.byHash.get(hashShareToken(token)) as
        { conversation_id: string; user_id: string } | undefined;
      return row ? { conversation_id: row.conversation_id, user_id: row.user_id } : null;
    },
  };
}
