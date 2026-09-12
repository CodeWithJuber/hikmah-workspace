/** The chat surface's settings, one row per owner.
 *
 * Raw node:sqlite for the same reason `lib/runs/store.ts` uses it: this module
 * imports nothing from Next, so it can be exercised against a real database
 * without a server.
 */

import { mergeChatSettings, readChatSettings, type ChatSettings } from './settings.ts';

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
};

export function createChatSettingsStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    read: db.prepare('SELECT body FROM chat_settings WHERE user_id = ?'),
    // Last write wins. There is one owner and one box, and the revision
    // protocol the workspace blob uses is precisely what makes a losing write
    // disable saving for the rest of a tab's life.
    write: db.prepare(
      `INSERT INTO chat_settings (user_id, body, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ),
  };

  return {
    /** The owner's settings, defaults included, whatever is or is not stored. */
    read(userId: string): ChatSettings {
      const row = statements.read.get(userId) as { body?: string } | undefined;
      return readChatSettings(row?.body);
    },

    /** Fold an update in and return what is now stored. */
    update(userId: string, patch: unknown): ChatSettings {
      const next = mergeChatSettings(this.read(userId), patch);
      statements.write.run(userId, JSON.stringify(next), now());
      return next;
    },
  };
}
