-- PR-18: GitHub exemplar connections and receipts.
--
-- `github_connections` holds one row per connected GitHub account: the label
-- the owner gave it and the permission ids they declared when they pasted
-- their fine-grained token. The token itself lives in the encrypted secret
-- store bound to the connection id (`github:<id>`), never in this table.
--
-- `github_receipts` is append-only: one row per exemplar action the flow
-- attempted, with the sha256 of the canonical params so the action is
-- verifiable later without keeping the params themselves. Rows are never
-- updated or deleted — a receipt that changed after the fact would prove
-- nothing.

CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_declared TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_github_connections_user ON github_connections(user_id);

CREATE TABLE github_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  action TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_github_receipts_connection ON github_receipts(connection_id);
CREATE INDEX idx_github_receipts_user ON github_receipts(user_id);
