/** Team workspaces, membership, content consents and the content-access audit
 * log, over the raw sqlite handle.
 *
 * Same shape and reasons as lib/authz/store.ts: prepared once, no Next
 * imports, so a test drives it against :memory: without a server. The
 * Next-facing layer in ./server.ts only resolves the storage handle; every
 * read and write here takes explicit user ids.
 *
 * Hard rules this store enforces structurally:
 *  - invites are in-app records (status 'pending'); nothing here sends email;
 *  - removal DEACTIVATES (status 'removed') — rows are never deleted;
 *  - consent revocation timestamps (revoked_at) — consent rows are never deleted;
 *  - every consented content read is logged by the caller via logContentAccess.
 */
import { randomUUID } from 'node:crypto';
import { isTeamRole, type TeamRole } from './roles.ts';
import type { SqliteHandle } from '../runs/store.ts';

export type Workspace = {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
};

export type MemberStatus = 'pending' | 'active' | 'removed';

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  teamRole: TeamRole;
  status: MemberStatus;
  grantedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentConsent = {
  id: string;
  workspaceId: string;
  staffUserId: string;
  granterUserId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ContentAccessEntry = {
  id: string;
  actorId: string;
  resourceType: string;
  resourceId: string;
  ownerUserId: string;
  consentId: string | null;
  createdAt: string;
};

const isStatus = (value: unknown): value is MemberStatus =>
  value === 'pending' || value === 'active' || value === 'removed';

export function createTeamStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    createWorkspace: db.prepare(
      'INSERT INTO workspaces (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)',
    ),
    getWorkspace: db.prepare(
      'SELECT id, name, owner_user_id, created_at FROM workspaces WHERE id = ?',
    ),
    listWorkspaces: db.prepare(
      `SELECT w.id, w.name, w.owner_user_id, w.created_at FROM workspaces w
       WHERE w.owner_user_id = ?
          OR EXISTS (SELECT 1 FROM workspace_members m
                     WHERE m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active')
       ORDER BY w.created_at DESC`,
    ),
    upsertMember: db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, team_role, status, granted_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET team_role = excluded.team_role,
         status = excluded.status, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
    ),
    getMember: db.prepare(
      `SELECT workspace_id, user_id, team_role, status, granted_by, created_at, updated_at
       FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ),
    listMembers: db.prepare(
      `SELECT workspace_id, user_id, team_role, status, granted_by, created_at, updated_at
       FROM workspace_members WHERE workspace_id = ? ORDER BY created_at`,
    ),
    deactivateMember: db.prepare(
      `UPDATE workspace_members SET status = 'removed', updated_at = ?
       WHERE workspace_id = ? AND user_id = ? AND status <> 'removed'`,
    ),
    // The caller's active team role on workspaces owned by ownerUserId. A
    // caller teamed with several of the owner's workspaces gets the strongest
    // role: member outranks viewer.
    roleOnOwner: db.prepare(
      `SELECT m.team_role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE w.owner_user_id = ? AND m.user_id = ? AND m.status = 'active'`,
    ),
    // Owner ids of every workspace the caller is an active member of: the set
    // of people whose per-user-keyed rows (files, secrets) the caller may see.
    ownerIdsForMember: db.prepare(
      `SELECT DISTINCT w.owner_user_id FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = ? AND m.status = 'active'`,
    ),
    createConsent: db.prepare(
      `INSERT INTO team_content_consents
         (id, workspace_id, staff_user_id, granter_user_id, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(workspace_id, staff_user_id) DO UPDATE SET
         granter_user_id = excluded.granter_user_id, expires_at = excluded.expires_at,
         revoked_at = NULL, created_at = excluded.created_at`,
    ),
    getConsent: db.prepare(
      `SELECT id, workspace_id, staff_user_id, granter_user_id, expires_at, revoked_at, created_at
       FROM team_content_consents WHERE workspace_id = ? AND staff_user_id = ?`,
    ),
    listConsents: db.prepare(
      `SELECT id, workspace_id, staff_user_id, granter_user_id, expires_at, revoked_at, created_at
       FROM team_content_consents WHERE workspace_id = ? ORDER BY created_at`,
    ),
    revokeConsent: db.prepare(
      `UPDATE team_content_consents SET revoked_at = ?
       WHERE workspace_id = ? AND staff_user_id = ? AND revoked_at IS NULL`,
    ),
    insertAccess: db.prepare(
      `INSERT INTO team_content_access_log
         (id, actor_id, resource_type, resource_id, owner_user_id, consent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listAccessByOwner: db.prepare(
      `SELECT id, actor_id, resource_type, resource_id, owner_user_id, consent_id, created_at
       FROM team_content_access_log WHERE owner_user_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ),
    listAccessByActor: db.prepare(
      `SELECT id, actor_id, resource_type, resource_id, owner_user_id, consent_id, created_at
       FROM team_content_access_log WHERE actor_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ),
    countAccessByOwner: db.prepare(
      'SELECT COUNT(*) AS n FROM team_content_access_log WHERE owner_user_id = ?',
    ),
    countAccessByActor: db.prepare(
      'SELECT COUNT(*) AS n FROM team_content_access_log WHERE actor_id = ?',
    ),
  };

  const toWorkspace = (row: {
    id: string;
    name: string;
    owner_user_id: string;
    created_at: string;
  }): Workspace => ({
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  });

  const toMember = (row: {
    workspace_id: string;
    user_id: string;
    team_role: string;
    status: string;
    granted_by: string | null;
    created_at: string;
    updated_at: string;
  }): WorkspaceMember | null => {
    if (!isTeamRole(row.team_role) || !isStatus(row.status)) return null;
    return {
      workspaceId: row.workspace_id,
      userId: row.user_id,
      teamRole: row.team_role,
      status: row.status,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const toConsent = (row: {
    id: string;
    workspace_id: string;
    staff_user_id: string;
    granter_user_id: string;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }): ContentConsent => ({
    id: row.id,
    workspaceId: row.workspace_id,
    staffUserId: row.staff_user_id,
    granterUserId: row.granter_user_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  });

  const toAccess = (row: {
    id: string;
    actor_id: string;
    resource_type: string;
    resource_id: string;
    owner_user_id: string;
    consent_id: string | null;
    created_at: string;
  }): ContentAccessEntry => ({
    id: row.id,
    actorId: row.actor_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ownerUserId: row.owner_user_id,
    consentId: row.consent_id,
    createdAt: row.created_at,
  });

  return {
    createWorkspace(name: string, ownerUserId: string): Workspace {
      const at = now();
      const id = randomUUID();
      statements.createWorkspace.run(id, name, ownerUserId, at);
      return { id, name, ownerUserId, createdAt: at };
    },

    getWorkspace(workspaceId: string): Workspace | null {
      const row = statements.getWorkspace.get(workspaceId) as
        { id: string; name: string; owner_user_id: string; created_at: string } | undefined;
      return row ? toWorkspace(row) : null;
    },

    /** Workspaces the user owns or is an active member of. */
    listWorkspaces(userId: string): Workspace[] {
      const rows = statements.listWorkspaces.all(userId, userId) as Array<{
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
      }>;
      return rows.map(toWorkspace);
    },

    /** Invite a user: an in-app record in 'pending' state. No email, no
     * external send — acceptance flips the status to 'active'. */
    inviteMember(
      workspaceId: string,
      userId: string,
      teamRole: TeamRole,
      grantedBy: string,
    ): WorkspaceMember {
      const at = now();
      statements.upsertMember.run(workspaceId, userId, teamRole, 'pending', grantedBy, at, at);
      return this.getMember(workspaceId, userId) as WorkspaceMember;
    },

    activateMember(workspaceId: string, userId: string): WorkspaceMember | null {
      const existing = this.getMember(workspaceId, userId);
      if (!existing || existing.status !== 'pending') return existing;
      statements.upsertMember.run(
        workspaceId,
        userId,
        existing.teamRole,
        'active',
        existing.grantedBy,
        existing.createdAt,
        now(),
      );
      return this.getMember(workspaceId, userId);
    },

    getMember(workspaceId: string, userId: string): WorkspaceMember | null {
      const row = statements.getMember.get(workspaceId, userId) as
        Parameters<typeof toMember>[0] | undefined;
      return row ? toMember(row) : null;
    },

    listMembers(workspaceId: string): WorkspaceMember[] {
      const rows = statements.listMembers.all(workspaceId) as Array<Parameters<typeof toMember>[0]>;
      const out: WorkspaceMember[] = [];
      for (const row of rows) {
        const member = toMember(row);
        if (member) out.push(member);
      }
      return out;
    },

    /** Deactivate, never delete: the row stays with status 'removed'. */
    removeMember(workspaceId: string, userId: string): boolean {
      const result = statements.deactivateMember.run(now(), workspaceId, userId) as {
        changes: number;
      };
      return result.changes > 0;
    },

    /** The caller's strongest active team role across the owner's workspaces,
     * or null. Unknown stored roles fail closed to null via toMember-less
     * mapping here: only 'member'/'viewer' strings count. */
    teamRoleOnOwner(ownerUserId: string, callerId: string): TeamRole | null {
      const rows = statements.roleOnOwner.all(ownerUserId, callerId) as Array<{
        team_role: string;
      }>;
      let best: TeamRole | null = null;
      for (const row of rows) {
        if (row.team_role === 'member') return 'member';
        if (row.team_role === 'viewer') best = 'viewer';
      }
      return best;
    },

    /** Owner ids of every workspace the caller is an active member of. */
    ownerIdsForMember(callerId: string): string[] {
      const rows = statements.ownerIdsForMember.all(callerId) as Array<{
        owner_user_id: string;
      }>;
      return rows.map((row) => row.owner_user_id);
    },

    grantContentConsent(
      workspaceId: string,
      staffUserId: string,
      granterUserId: string,
      expiresAt: string | null = null,
    ): ContentConsent {
      const id = randomUUID();
      statements.createConsent.run(id, workspaceId, staffUserId, granterUserId, expiresAt, now());
      return this.getConsent(workspaceId, staffUserId) as ContentConsent;
    },

    getConsent(workspaceId: string, staffUserId: string): ContentConsent | null {
      const row = statements.getConsent.get(workspaceId, staffUserId) as
        Parameters<typeof toConsent>[0] | undefined;
      return row ? toConsent(row) : null;
    },

    /** A consent counts only while unrevoked and unexpired. */
    activeConsent(workspaceId: string, staffUserId: string): ContentConsent | null {
      const consent = this.getConsent(workspaceId, staffUserId);
      if (!consent || consent.revokedAt) return null;
      if (consent.expiresAt && consent.expiresAt <= now()) return null;
      return consent;
    },

    listConsents(workspaceId: string): ContentConsent[] {
      const rows = statements.listConsents.all(workspaceId) as Array<
        Parameters<typeof toConsent>[0]
      >;
      return rows.map(toConsent);
    },

    /** Revoke by timestamping, never by deleting. */
    revokeContentConsent(workspaceId: string, staffUserId: string): boolean {
      const result = statements.revokeConsent.run(now(), workspaceId, staffUserId) as {
        changes: number;
      };
      return result.changes > 0;
    },

    /** One row per consented content read. The caller writes it at read time;
     * a throw surfaces, because a content read whose audit could not be
     * written is a read that should not claim to be audited. */
    logContentAccess(
      actorId: string,
      resourceType: string,
      resourceId: string,
      ownerUserId: string,
      consentId: string | null = null,
    ): void {
      statements.insertAccess.run(
        randomUUID(),
        actorId,
        resourceType,
        resourceId,
        ownerUserId,
        consentId,
        now(),
      );
    },

    listAccessByOwner(
      ownerUserId: string,
      limit = 50,
      offset = 0,
    ): { entries: ContentAccessEntry[]; total: number } {
      const page = Math.min(Math.max(limit, 1), 200);
      const rows = statements.listAccessByOwner.all(
        ownerUserId,
        page,
        Math.max(offset, 0),
      ) as Array<Parameters<typeof toAccess>[0]>;
      const total = (statements.countAccessByOwner.get(ownerUserId) as { n: number }).n;
      return { entries: rows.map(toAccess), total };
    },

    listAccessByActor(
      actorId: string,
      limit = 50,
      offset = 0,
    ): { entries: ContentAccessEntry[]; total: number } {
      const page = Math.min(Math.max(limit, 1), 200);
      const rows = statements.listAccessByActor.all(actorId, page, Math.max(offset, 0)) as Array<
        Parameters<typeof toAccess>[0]
      >;
      const total = (statements.countAccessByActor.get(actorId) as { n: number }).n;
      return { entries: rows.map(toAccess), total };
    },
  };
}

export type TeamStore = ReturnType<typeof createTeamStore>;
