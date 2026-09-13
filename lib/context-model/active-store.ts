/** The owner's activated checkpoint, read the way a run needs it.
 *
 * `app/api/context-model/route.ts` already reads these two tables, but through
 * the D1-shaped async shim and behind `ownerIdentity`. A run needs the same
 * rows synchronously enough to decide which grammar to load, and for whoever
 * owns the run rather than for the owner of the deployment — so this reads them
 * directly, scoped by user id, importing nothing from Next.
 */

import type { ActiveCheckpoint } from './server.ts';

export type SqliteHandle = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
};

export type ObjectStore = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};

export function createActiveCheckpointStore(db: SqliteHandle, bucket: ObjectStore) {
  const statements = {
    // The route writes this key as `${userId}:${language}`; matching on
    // user_id as well means a malformed id cannot select another owner's row.
    active: db.prepare(
      'SELECT version_id FROM context_active WHERE id = ? AND user_id = ? AND language = ?',
    ),
    version: db.prepare('SELECT blob_key FROM context_versions WHERE id = ? AND user_id = ?'),
  };

  const store: ActiveCheckpoint = {
    activeVersion(userId, language) {
      const row = statements.active.get(userId + ':' + language, userId, language) as
        { version_id?: string } | undefined;
      return row?.version_id ?? null;
    },

    async read(userId, versionId) {
      const row = statements.version.get(versionId, userId) as { blob_key?: string } | undefined;
      if (!row?.blob_key) throw Error('Checkpoint row not found.');
      const object = await bucket.get(row.blob_key);
      if (!object) throw Error('Checkpoint bytes are unavailable.');
      return JSON.parse(await object.text());
    },
  };
  return store;
}
