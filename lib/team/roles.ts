/** Workspace membership roles: who may touch another person's resources.
 *
 * A SEPARATE vocabulary from the deployment staff roles in lib/authz/roles.ts,
 * by JEV decision (2026-09-30, confidence 0.85): staff roles govern operating
 * the deployment, team roles govern resource access. Merging them would let a
 * team viewer inherit staff console permissions.
 *
 *  - `member` read and write the workspace owner's resources, and may be
 *             re-invited / removed only by the owner.
 *  - `viewer` read the workspace owner's resources. Changes nothing.
 *
 * Pure over its inputs and importing nothing from Next, like lib/authz/roles.ts,
 * so a test drives the matrix directly. Unknown roles carry nothing: a row the
 * code does not recognise fails closed, not open.
 */

export type TeamRole = 'member' | 'viewer';

/** What a team role may do to the workspace owner's resources. Named
 * `resource:verb` like the staff permissions, but a different dimension. */
export type TeamPermission = 'resources:read' | 'resources:write';

const TEAM_ROLE_PERMISSIONS: Record<TeamRole, readonly TeamPermission[]> = {
  // Read and write: a teammate pairing on a workspace.
  member: ['resources:read', 'resources:write'],
  // Read-only by design: review without the power to change.
  viewer: ['resources:read'],
};

export function isTeamRole(value: unknown): value is TeamRole {
  return value === 'member' || value === 'viewer';
}

/** The permissions a team role carries, as a fresh array. */
export function teamPermissionsFor(role: TeamRole): TeamPermission[] {
  return [...TEAM_ROLE_PERMISSIONS[role]];
}

/** Whether the team role carries the permission. Unknown roles carry nothing:
 * fail closed. */
export function hasTeamPermission(role: unknown, permission: TeamPermission): boolean {
  if (!isTeamRole(role)) return false;
  return (TEAM_ROLE_PERMISSIONS[role] as readonly TeamPermission[]).includes(permission);
}
