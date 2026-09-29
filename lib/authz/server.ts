/** Who the caller is allowed to be, for the staff console and admin APIs.
 *
 * The thin Next-facing layer over ./roles.ts and ./store.ts. The id-pinned
 * owner gate in lib/kernel/server.ts is untouched — this builds on top of it:
 * `ownerIdentity()` still decides who the owner is, and a passing call seeds
 * the owner's row in `staff_roles` so the console can list them. Everyone else
 * is resolved from `staff_roles`, which only the owner can write.
 */
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { getStorage } from '@/server/storage.mjs';
import { database, identity, ownerIdentity, KernelHttpError } from '../kernel/server.ts';
import { createAuthzStore, type AuthzStore } from './store.ts';
import { hasPermission, isRole, permissionsFor, type Permission, type Role } from './roles.ts';

let cached: AuthzStore | undefined;

export function authzStore(): AuthzStore {
  cached ??= createAuthzStore(getStorage().raw);
  return cached;
}

/** The staff role for a user id, or null for a plain account.
 *
 * The pinned owner resolves from `kernel_owners` — the same row
 * `ownerIdentity()` bootstraps — never from this table, so a hand-edited
 * staff_roles row can neither create nor remove an owner. */
export async function roleForUser(userId: string): Promise<Role | null> {
  const owner = await database()
    .prepare('SELECT user_id FROM kernel_owners WHERE id = ?')
    .bind('owner')
    .first<{ user_id: string }>();
  if (owner?.user_id === userId) return 'owner';
  return authzStore().getRole(userId);
}

/** Seed the owner's staff row from the passing owner gate.
 *
 * Called only after `ownerIdentity()` has succeeded, so the id-pinned check
 * remains the single decider. The row exists so the staff console lists the
 * operator alongside support staff; it grants nothing by itself. */
async function seedOwnerRole(userId: string, grantedBy: string): Promise<void> {
  authzStore().setRole(userId, 'owner', grantedBy);
}

export type PermissionGrant = {
  user: { userId: string; email: string };
  role: Role;
  permissions: Permission[];
};

/** The signed-in caller, or throw: 401 without a session, 403 without the
 * permission. Server-enforced — the console hides buttons by role, but the
 * routes decide. */
export async function requirePermission(permission: Permission): Promise<PermissionGrant> {
  const user = await identity();
  // The owner gate first, exactly as it stands: an owner holds every
  // permission, and the passing check seeds their staff row.
  try {
    const owner = await ownerIdentity();
    await seedOwnerRole(owner.userId, owner.userId);
    return { user: owner, role: 'owner', permissions: permissionsFor('owner') };
  } catch (error) {
    if (!(error instanceof KernelHttpError) || error.status !== 403) throw error;
  }
  const role = await roleForUser(user.userId);
  if (role && hasPermission(role, permission))
    return { user, role, permissions: permissionsFor(role) };
  throw new KernelHttpError(403, 'This needs a staff role your account does not have.');
}

/** One audit row for an admin mutation. The action names are the vocabulary
 * the staff console shows: `tier.override`, `role.grant`, `role.revoke`,
 * `user.ban`, `user.unban`, `billing.refund`. */
export function audit(
  actorId: string,
  action: string,
  targetUserId?: string | null,
  detail?: string | null,
): void {
  authzStore().logAudit(actorId, action, targetUserId ?? null, detail ?? null);
}

/** Whether the account is banned. Checked at the session gate
 * (app/chatgpt-auth.ts) so one row locks every route that needs a user. */
export function isBanned(userId: string): boolean {
  try {
    return authzStore().isBanned(userId);
  } catch {
    // A ban check must never lock everyone out because storage hiccuped:
    // fail open here, the same way the rest of the product treats a missing
    // database as unavailable rather than forbidden.
    return false;
  }
}

let authDb: DatabaseSync | undefined;

/** Read-only handle on better-auth's own database, for the staff console's
 * user list. The plugin owns these rows; the app only reads the columns it
 * shows (id, name, email, createdAt) and never writes them. */
export function authDatabase(): DatabaseSync {
  if (!authDb) {
    const directory = process.env.HIKMAH_DATA_DIR || resolve('.data');
    try {
      authDb = new DatabaseSync(join(directory, 'auth.sqlite'), { readOnly: true });
    } catch (error) {
      throw new KernelHttpError(
        503,
        'The account database is not reachable. Your input is preserved; try again.',
      );
    }
  }
  return authDb;
}

/** The roles the console may grant. The owner row is managed by the gate, so
 * it is not grantable here. */
export const GRANTABLE_ROLES: Role[] = ['support'];

export function assertGrantable(role: unknown): asserts role is 'support' {
  if (role !== 'support') throw new KernelHttpError(400, 'Only the support role can be granted.');
}

export type TargetAccount = { id: string; email: string };

/** The account an admin mutation targets, verified rather than trusted.
 *
 * A user-supplied id is never acted on without checking it names a real
 * account (OWASP API#1), and the pinned operator account is never a valid
 * target — including for the operator themselves, so no misclick can demote
 * or lock out the deployment's owner. */
export async function targetAccount(targetId: string): Promise<TargetAccount> {
  if (!targetId || targetId.length > 128) throw new KernelHttpError(404, 'Unknown account.');
  const row = authDatabase().prepare('SELECT id, email FROM user WHERE id = ?').get(targetId) as
    { id?: string; email?: string } | undefined;
  if (!row?.id || !row.email) throw new KernelHttpError(404, 'Unknown account.');
  if ((await roleForUser(row.id)) === 'owner')
    throw new KernelHttpError(403, 'The operator account cannot be changed here.');
  return { id: row.id, email: row.email };
}

export { isRole };
