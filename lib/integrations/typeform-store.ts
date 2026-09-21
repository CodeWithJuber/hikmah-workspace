import type { SqliteHandle } from '../runs/store.ts';
import type { TypeformGrant } from './typeform-types.ts';

/** Grants are bound to both the immutable owner and the actual credential.
 * Rotating a token cannot silently transfer the old account's grants. */
export function createTypeformGrantStore(db: SqliteHandle) {
  return {
    ownerId(): string | null {
      return (db.prepare("SELECT user_id FROM kernel_owners WHERE id='owner'").get() as
        { user_id: string } | undefined)?.user_id ?? null;
    },
    findUser(email: string): string | null {
      return (db.prepare('SELECT id FROM "user" WHERE lower(email)=?').get(email.toLowerCase()) as
        { id: string } | undefined)?.id ?? null;
    },
    list(ownerId: string, connectionKey: string, userId?: string): TypeformGrant[] {
      const rows = db.prepare(
        `SELECT g.user_id, g.form_id, g.form_title, u.email FROM typeform_grants g
         JOIN "user" u ON u.id=g.user_id
         WHERE g.owner_id=? AND g.connection_key=? ${userId ? 'AND g.user_id=?' : ''}
         ORDER BY g.form_title, u.email LIMIT 2000`,
      ).all(...[ownerId, connectionKey, ...(userId ? [userId] : [])]) as
        { user_id: string; form_id: string; form_title: string; email: string }[];
      return rows.map((row) => ({
        userId: row.user_id, email: row.email, formId: row.form_id, title: row.form_title,
      }));
    },
    allows(ownerId: string, connectionKey: string, userId: string, formId: string): boolean {
      return Boolean(db.prepare(
        'SELECT 1 FROM typeform_grants WHERE owner_id=? AND connection_key=? AND user_id=? AND form_id=?',
      ).get(ownerId, connectionKey, userId, formId));
    },
    save(ownerId: string, connectionKey: string, userId: string, formId: string, title: string) {
      db.prepare(
        `INSERT INTO typeform_grants(owner_id, connection_key, user_id, form_id, form_title, created_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,user_id,form_id)
         DO UPDATE SET connection_key=excluded.connection_key, form_title=excluded.form_title,
         created_at=excluded.created_at`,
      ).run(ownerId, connectionKey, userId, formId, title, new Date().toISOString());
    },
    remove(ownerId: string, userId: string, formId: string) {
      db.prepare('DELETE FROM typeform_grants WHERE owner_id=? AND user_id=? AND form_id=?')
        .run(ownerId, userId, formId);
    },
    clear(ownerId: string) {
      db.prepare('DELETE FROM typeform_grants WHERE owner_id=?').run(ownerId);
    },
  };
}
export type TypeformGrantStore = ReturnType<typeof createTypeformGrantStore>;
