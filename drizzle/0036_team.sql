-- PR-22 team foundation: workspace membership, consented content access, audited access.
--
-- Two deliberate model choices, both confirmed by JEV judgment calls on
-- 2026-09-30 before this file was written:
--
-- 1. OWNERSHIP LIVES IN THE EXISTING user_id COLUMNS. runs, conversations,
--    workspace_files, workspace_secrets and memories all carry user_id NOT
--    NULL as the row's owner (files/secrets even key on (user_id, path/name)).
--    A parallel resource_ownership table would be a second source of truth
--    that can drift; the isolation layer (lib/team/enforcement.ts) reads the
--    owner from the row itself and fails closed on anything it cannot resolve.
--
-- 2. TEAM ROLES ARE A SEPARATE VOCABULARY FROM DEPLOYMENT STAFF ROLES.
--    lib/authz's owner/support govern operating the deployment; team_role
--    (member/viewer) governs reading another person's resources. Merging them
--    would let a team viewer inherit staff console permissions, so the two
--    dimensions stay orthogonal.
--
-- Hand-written on purpose, like 0014/0031: server/storage.mjs applies
-- drizzle/*.sql in lexical order and pins each file's sha256, so this file
-- must never be edited after it ships.

-- A workspace is a named sharing scope anchored at its owner. A person's own
-- rows need no workspace row: their user_id is the owner of record. A
-- workspace exists when someone wants teammates to read (viewer) or read and
-- write (member) their resources.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX workspaces_by_owner ON workspaces (owner_user_id, created_at);

-- Membership. Removal DEACTIVATES (status = 'removed'); rows are never
-- deleted, so the grant history survives for the audit trail. Invites are
-- in-app records: status starts 'pending' and no email is ever sent.
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL,
  team_role TEXT NOT NULL CHECK (team_role IN ('member', 'viewer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed')),
  granted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX workspace_members_by_user ON workspace_members (user_id, status);

-- Consented content access. Support staff see METADATA by default (names,
-- counts, timestamps — lib/team/support-view.ts projects it by construction,
-- never content). Reading a person's actual content needs an explicit grant
-- from the workspace owner. The grant is a row with an expiry and a
-- revocation timestamp, not a flag on the user, so it can lapse and be
-- withdrawn without touching anything else.
CREATE TABLE team_content_consents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  staff_user_id TEXT NOT NULL,
  granter_user_id TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, staff_user_id)
);
CREATE INDEX team_content_consents_by_staff ON team_content_consents (staff_user_id, revoked_at);

-- Every consented content read writes one row here. A dedicated table rather
-- than extending admin_audit_log: different volume (reads, not admin
-- mutations), queried by resource and by owner rather than by admin action.
CREATE TABLE team_content_access_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  consent_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX team_content_access_log_by_actor ON team_content_access_log (actor_id, created_at);
CREATE INDEX team_content_access_log_by_owner ON team_content_access_log (owner_user_id, created_at);
