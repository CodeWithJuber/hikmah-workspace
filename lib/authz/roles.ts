/** Named roles and the permissions they carry.
 *
 * Billing tiers (owner/byok/managed) say whose key pays for a run. Roles say
 * who may operate the deployment. The two are deliberately separate: granting
 * someone a staff role never changes what their own runs cost, and changing
 * someone's tier never grants them a permission.
 *
 * Pure over its inputs and importing nothing from Next, so the matrix can be
 * driven directly by a test rather than through an HTTP round trip — the same
 * reason lib/billing/entitlements.ts is pure.
 */

/** Who may operate the deployment.
 *
 *  - `owner`   the deployment's operator. Seeded from the id-pinned
 *              `kernel_owners` row that `ownerIdentity()` owns; the row here
 *              only mirrors it so the console can list it.
 *  - `support` read-only staff. Sees users, usage and the audit log; changes
 *              nothing. A business with one operator and no second pair of
 *              eyes is the failure mode this role exists to prevent.
 */
export type Role = 'owner' | 'support';

/** The things a role may do. Named `resource:verb` so a new surface adds a
 * permission rather than reinterpreting an old one. */
export type Permission =
  'users:read' | 'users:manage' | 'billing:override' | 'runs:execute' | 'audit:read';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // The operator may do everything, including the staff-initiated runs that
  // `runs:execute` names. Nothing in the product grants a run to anyone but
  // the signed-in account today, so the permission is vocabulary for the
  // consent-logged impersonation Phase 2 may add — not a check with a hole.
  owner: ['users:read', 'users:manage', 'billing:override', 'runs:execute', 'audit:read'],
  // Read-only by design: listing people and reading the audit trail is the
  // whole job. Anything that changes state is the owner's.
  support: ['users:read', 'audit:read'],
};

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'support';
}

/** The permissions a role carries, as a fresh array. */
export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Whether the role carries the permission. Unknown roles carry nothing:
 * a row the code does not recognise must fail closed, not open. */
export function hasPermission(role: unknown, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission);
}
