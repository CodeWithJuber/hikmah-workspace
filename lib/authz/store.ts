/** Staff roles, bans and the admin audit log, over the raw sqlite handle.
 *
 * Same shape and the same reasons as lib/billing/store.ts: prepared once, no
 * Next imports, so a test can drive it against :memory: without a server.
 * The Next-facing layer in ./server.ts only resolves *who* the caller is; every
 * read and write here takes an explicit user id.
 */
import { randomUUID } from 'node:crypto';
import { isRole, type Role } from './roles.ts';
import type { SqliteHandle } from '../runs/store.ts';

export type AuditEntry = {
  id: string;
  actorId: string;
  action: string;
  targetUserId: string | null;
  detail: string | null;
  createdAt: string;
};

export function createAuthzStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    getRole: db.prepare('SELECT role FROM staff_roles WHERE user_id = ?'),
    setRole: db.prepare(
      `INSERT INTO staff_roles (user_id, role, granted_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role,
         granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
    ),
    removeRole: db.prepare('DELETE FROM staff_roles WHERE user_id = ?'),
    insertAudit: db.prepare(
      `INSERT INTO admin_audit_log (id, actor_id, action, target_user_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    listAudit: db.prepare(
      `SELECT id, actor_id, action, target_user_id, detail, created_at
       FROM admin_audit_log ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ),
    countAudit: db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log'),
    getBan: db.prepare('SELECT user_id FROM banned_users WHERE user_id = ?'),
    setBan: db.prepare(
      'INSERT INTO banned_users (user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?)',
    ),
    clearBan: db.prepare('DELETE FROM banned_users WHERE user_id = ?'),
  };

  return {
    /** The staff role row, or null. The pinned owner is resolved by the caller
     * from `kernel_owners`, not here: this store must never be the thing that
     * decides who the owner is. */
    getRole(userId: string): Role | null {
      const row = statements.getRole.get(userId) as { role?: string } | undefined;
      return row && isRole(row.role) ? row.role : null;
    },

    setRole(userId: string, role: Role, grantedBy: string): void {
      const at = now();
      statements.setRole.run(userId, role, grantedBy, at, at);
    },

    removeRole(userId: string): void {
      statements.removeRole.run(userId);
    },

    /** One row per admin mutation. Fire-and-forget for the caller is fine —
     * the row is the point — but a throw here surfaces: a mutation whose audit
     * could not be written is a mutation that should not claim to be done. */
    logAudit(
      actorId: string,
      action: string,
      targetUserId: string | null = null,
      detail: string | null = null,
    ): void {
      statements.insertAudit.run(randomUUID(), actorId, action, targetUserId, detail, now());
    },

    /** Audit entries, newest first. `rowid` is the tiebreaker because two
     * mutations can land in the same millisecond and ids are random UUIDs. */
    listAudit(limit = 50, offset = 0): { entries: AuditEntry[]; total: number } {
      const rows = statements.listAudit.all(
        Math.min(Math.max(limit, 1), 200),
        Math.max(offset, 0),
      ) as Array<{
        id: string;
        actor_id: string;
        action: string;
        target_user_id: string | null;
        detail: string | null;
        created_at: string;
      }>;
      const total = (statements.countAudit.get() as { n: number }).n;
      return {
        entries: rows.map((row) => ({
          id: row.id,
          actorId: row.actor_id,
          action: row.action,
          targetUserId: row.target_user_id,
          detail: row.detail,
          createdAt: row.created_at,
        })),
        total,
      };
    },

    isBanned(userId: string): boolean {
      return Boolean(statements.getBan.get(userId));
    },

    setBanned(userId: string, bannedBy: string, reason: string | null): void {
      statements.setBan.run(userId, bannedBy, reason, now());
    },

    clearBanned(userId: string): void {
      statements.clearBan.run(userId);
    },
  };
}

export type AuthzStore = ReturnType<typeof createAuthzStore>;
