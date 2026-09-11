-- Saved SSH hosts, and a record of every command run against one.
--
-- The model may name a host id and a command. It may never supply a hostname, a
-- port, a username or a key: those come from this table, so an instruction
-- injected through a fetched page or a tool description cannot redirect a
-- connection to someone else's machine. The same reasoning puts the credential
-- in the encrypted secret store under destination 'ssh:<id>' rather than here.
CREATE TABLE ssh_hosts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  -- 'key' or 'password'; the value itself lives in workspace_secrets.
  auth_kind TEXT NOT NULL,
  -- SHA-256 of the host key, recorded on the first connection. A later change
  -- refuses the connection rather than warning, because a changed host key is
  -- what a redirected connection looks like.
  fingerprint TEXT,
  -- Commands matching this list may run without a prompt. Read-only by
  -- convention, evaluated on the server, empty by default.
  auto_approve TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX ssh_hosts_name ON ssh_hosts (user_id, name);

-- What the assistant asked to run, what the owner decided, and what happened.
-- Kept separately from run_events because events are pruned at the end of each
-- step: an audit of commands executed on someone's servers has to outlive that.
CREATE TABLE tool_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  host_id TEXT REFERENCES ssh_hosts (id) ON DELETE SET NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  exit_code INTEGER,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  ended_at TEXT
);
CREATE INDEX tool_runs_run ON tool_runs (run_id);
CREATE INDEX tool_runs_user ON tool_runs (user_id, requested_at);
