-- Named staff roles and the audit trail for every admin mutation.
--
-- Billing tiers (owner/byok/managed in user_tiers) say whose key pays for a
-- run. These tables say who may operate the deployment: role assignment is
-- separate from billing on purpose, so giving someone a staff role never
-- changes what their own runs cost.
CREATE TABLE staff_roles (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'support')),
  granted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Every admin mutation writes one row here: who, what, whose account, when.
-- Nothing in the product reads this except the staff console; it exists so a
-- disputed override, ban or refund can be reconstructed afterwards.
CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_log_by_actor ON admin_audit_log (actor_id, created_at);
CREATE INDEX admin_audit_log_by_target ON admin_audit_log (target_user_id, created_at);
-- Banned accounts are refused at the session gate (see app/chatgpt-auth.ts):
-- every route that requires a user goes through getChatGPTUser, so one row
-- here locks the whole product for that account.
CREATE TABLE banned_users (
  user_id TEXT PRIMARY KEY,
  banned_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
