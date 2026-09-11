CREATE TABLE workspace_secrets (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  destination TEXT NOT NULL,
  sealed TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);
