/** The ownership question, answered in one pure place.
 *
 * Every resource row names its owner in its own `user_id` column (JEV
 * decision, 2026-09-30, confidence 1.00): there is no parallel ownership
 * registry to drift. This module decides whether a caller may touch a resource
 * given the owner's id and the caller's team role on the owner's workspace.
 *
 * The rules:
 *  - the owner always may (read and write);
 *  - a team `member` of the owner's workspace may read and write;
 *  - a team `viewer` may read, never write;
 *  - anything else — no membership, unknown role, missing ids — is denied.
 *    Failing closed is the whole point: an unrecognised shape must not open
 *    a resource.
 */

import { hasTeamPermission, type TeamPermission, type TeamRole } from './roles.ts';

export type AccessVerdict = {
  allowed: boolean;
  /** Why, for the audit trail and the test names. */
  reason: 'owner' | 'team-member' | 'team-viewer' | 'no-membership' | 'unknown-role' | 'invalid';
};

export function canAccess(
  callerId: string | null | undefined,
  ownerUserId: string | null | undefined,
  teamRole: TeamRole | null | undefined,
  need: TeamPermission,
): AccessVerdict {
  if (!callerId || !ownerUserId) return { allowed: false, reason: 'invalid' };
  if (callerId === ownerUserId) return { allowed: true, reason: 'owner' };
  if (teamRole === 'member' && hasTeamPermission(teamRole, need))
    return { allowed: true, reason: 'team-member' };
  if (teamRole === 'viewer' && hasTeamPermission(teamRole, need))
    return { allowed: true, reason: 'team-viewer' };
  if (teamRole == null) return { allowed: false, reason: 'no-membership' };
  return { allowed: false, reason: 'unknown-role' };
}

/** Convenience for the common read/write split. */
export function canRead(
  callerId: string | null | undefined,
  ownerUserId: string | null | undefined,
  teamRole: TeamRole | null | undefined,
): boolean {
  return canAccess(callerId, ownerUserId, teamRole, 'resources:read').allowed;
}

export function canWrite(
  callerId: string | null | undefined,
  ownerUserId: string | null | undefined,
  teamRole: TeamRole | null | undefined,
): boolean {
  return canAccess(callerId, ownerUserId, teamRole, 'resources:write').allowed;
}
