/** The named isolation layer every user-resource route checks through.
 *
 * Ownership is read from each row's own `user_id` column (JEV decision
 * 2026-09-30): there is no parallel registry to drift. Team access is granted
 * through the owner's workspaces: an active member/viewer of any workspace
 * owned by the resource's owner may read; only a member may write.
 *
 * Every function fails closed with 404:
 *  - unknown resource id → 404 (never confirm or deny existence);
 *  - no membership and not the owner → 404 (same shape, no oracle);
 *  - viewer attempting a write → 404.
 * A 404 for "not yours" and "does not exist" is deliberate: distinguishing
 * them would let a caller probe for other people's resource ids.
 */

import { canAccess } from './ownership.ts';
import { type TeamStore } from './store.ts';
import type { SqliteHandle } from '../runs/store.ts';

/** Thrown for every denied access.
 *
 * Defined here rather than reusing lib/kernel's KernelHttpError on purpose:
 * kernel/server.ts uses TypeScript parameter properties, which node's
 * strip-only mode cannot parse, and it drags in the app auth tree — so no
 * test could import this module. A local error with the same status keeps
 * the enforcement layer directly testable; routes map it to a 404 response.
 */
export class TeamAccessDenied extends Error {
  readonly status = 404;
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'TeamAccessDenied';
  }
}

/** Resource kinds with a per-user owner column. The `ref` each kind takes:
 *  - run: the run id; memory: the memory id; conversation: the conversation id;
 *  - file: the workspace path; secret: the secret name.
 * Files and secrets are keyed (user_id, path/name), so the owner lookup must
 * consider the caller and the team owners the caller is teamed with. */
export type OwnableResource = 'run' | 'file' | 'secret' | 'memory' | 'conversation';

type Handle = Pick<SqliteHandle, 'prepare'>;

function ownerOfRun(db: Handle, id: string): string | null {
  const row = db.prepare('SELECT user_id FROM runs WHERE id = ?').get(id) as
    { user_id?: string } | undefined;
  return row?.user_id ?? null;
}

function ownerOfMemory(db: Handle, id: string): string | null {
  const row = db.prepare('SELECT user_id FROM memories WHERE id = ?').get(id) as
    { user_id?: string } | undefined;
  return row?.user_id ?? null;
}

function ownerOfConversation(db: Handle, id: string): string | null {
  const row = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(id) as
    { user_id?: string } | undefined;
  return row?.user_id ?? null;
}

/** Files and secrets live under a per-user key, so a path alone does not name
 * an owner. Check the caller's own rows first, then the rows of every
 * workspace owner the caller is teamed with. */
function ownerOfUserKeyedRow(
  db: Handle,
  table: 'workspace_files' | 'workspace_secrets',
  keyColumn: 'path' | 'name',
  team: TeamStore,
  callerId: string,
  key: string,
): string | null {
  const own = db
    .prepare(`SELECT user_id FROM ${table} WHERE user_id = ? AND ${keyColumn} = ?`)
    .get(callerId, key) as { user_id?: string } | undefined;
  if (own?.user_id) return own.user_id;
  const owners = team.ownerIdsForMember(callerId).filter((id) => id !== callerId);
  if (owners.length === 0) return null;
  const placeholders = owners.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT user_id FROM ${table} WHERE ${keyColumn} = ? AND user_id IN (${placeholders}) LIMIT 1`,
    )
    .get(key, ...owners) as { user_id?: string } | undefined;
  return row?.user_id ?? null;
}

/** The owner user id of the resource, or null when it cannot be resolved.
 * Never throws for a missing resource: unknown resolves to null and the
 * assertion below turns that into 404. */
export function ownerOf(
  db: Handle,
  team: TeamStore,
  resource: OwnableResource,
  callerId: string,
  ref: string,
): string | null {
  if (!ref) return null;
  switch (resource) {
    case 'run':
      return ownerOfRun(db, ref);
    case 'memory':
      return ownerOfMemory(db, ref);
    case 'conversation':
      return ownerOfConversation(db, ref);
    case 'file':
      return ownerOfUserKeyedRow(db, 'workspace_files', 'path', team, callerId, ref);
    case 'secret':
      return ownerOfUserKeyedRow(db, 'workspace_secrets', 'name', team, callerId, ref);
    default:
      return null;
  }
}

const notFound = () => new TeamAccessDenied();

function check(
  db: Handle,
  team: TeamStore,
  callerId: string,
  resource: OwnableResource,
  ref: string,
  need: 'resources:read' | 'resources:write',
): string {
  if (!callerId) throw notFound();
  const owner = ownerOf(db, team, resource, callerId, ref);
  if (!owner) throw notFound();
  if (owner === callerId) return owner;
  const role = team.teamRoleOnOwner(owner, callerId);
  const verdict = canAccess(callerId, owner, role, need);
  if (!verdict.allowed) throw notFound();
  return owner;
}

/** Assert the caller may READ the resource. Returns the owner's user id so
 * the route can scope its store calls to the owner. Throws 404 otherwise. */
export function assertCanRead(
  db: Handle,
  team: TeamStore,
  callerId: string,
  resource: OwnableResource,
  ref: string,
): string {
  return check(db, team, callerId, resource, ref, 'resources:read');
}

/** Assert the caller may WRITE the resource. Returns the owner's user id.
 * Throws 404 otherwise — including for viewers, who read but never write. */
export function assertCanWrite(
  db: Handle,
  team: TeamStore,
  callerId: string,
  resource: OwnableResource,
  ref: string,
): string {
  return check(db, team, callerId, resource, ref, 'resources:write');
}
