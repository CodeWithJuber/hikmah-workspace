/** Per-message thumbs up/down feedback, one row per message.
 *
 * Raw node:sqlite for the same reason `lib/runs/store.ts` uses it: this module
 * imports nothing from Next, so it can be exercised against a real database
 * without a server. Create with `getStorage().raw` (see the sibling stores)
 * and call from the feedback API route.
 *
 * A rating is a keyed write: rating again replaces the earlier value, and
 * `setFeedback(..., null)` clears the row. The message must belong to a
 * conversation owned by the caller — the check joins messages to
 * conversations on user_id so a guessed message id cannot be rated, and reads
 * nothing about someone else's conversation.
 */

/** The sibling settings store models only get/run; feedback lists with .all(),
 * so this handle names the three statements it actually uses. */
type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

export type FeedbackValue = 'up' | 'down';

export class FeedbackNotFound extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} not found for this user.`);
    this.name = 'FeedbackNotFound';
  }
}

export function createFeedbackStore(db: SqliteHandle) {
  const statements = {
    owned: db.prepare(
      `SELECT 1 FROM messages
       JOIN conversations ON conversations.id = messages.conversation_id
       WHERE messages.id = ? AND messages.conversation_id = ? AND conversations.user_id = ?`,
    ),
    upsert: db.prepare(
      `INSERT INTO message_feedback (message_id, conversation_id, user_id, value, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    ),
    clear: db.prepare('DELETE FROM message_feedback WHERE message_id = ? AND user_id = ?'),
    list: db.prepare(
      `SELECT mf.message_id, mf.value FROM message_feedback mf
       JOIN conversations c ON c.id = mf.conversation_id
       WHERE mf.conversation_id = ? AND c.user_id = ?
       ORDER BY mf.created_at ASC`,
    ),
  };

  /** Reject a value before it reaches the CHECK constraint, so the route can
   * answer 400 rather than 500. */
  function assertValue(value: unknown): asserts value is FeedbackValue {
    if (value !== 'up' && value !== 'down') throw new RangeError(`Invalid feedback value.`);
  }

  return {
    /** Rate a message, or clear the rating with null.
     *
     * Throws FeedbackNotFound when the message does not belong to a
     * conversation of this user: the route answers that the same way it
     * answers a missing row, so the failure cannot be used to discover that
     * someone else's message exists. */
    setFeedback(
      messageId: string,
      conversationId: string,
      userId: string,
      value: FeedbackValue | null,
    ): void {
      if (value !== null) assertValue(value);
      const row = statements.owned.get(messageId, conversationId, userId) as
        Record<string, never> | undefined;
      if (!row) throw new FeedbackNotFound(messageId);
      if (value === null) {
        statements.clear.run(messageId, userId);
        return;
      }
      statements.upsert.run(messageId, conversationId, userId, value, new Date().toISOString());
    },

    /** Every rating on one conversation, for this user only: message id to
     * 'up' | 'down'. The join keeps another owner's conversation from
     * leaking ratings even if the row's conversation_id is guessed. */
    getFeedback(conversationId: string, userId: string): Record<string, FeedbackValue> {
      const rows = statements.list.all(conversationId, userId) as {
        message_id: string;
        value: FeedbackValue;
      }[];
      const out: Record<string, FeedbackValue> = {};
      for (const row of rows) out[row.message_id] = row.value;
      return out;
    },
  };
}

export type FeedbackStore = ReturnType<typeof createFeedbackStore>;
