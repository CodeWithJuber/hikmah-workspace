-- Workspace files, as rows.
--
-- They used to live inside the workspace-state JSON blob, which capped them at
-- twelve files of eighty thousand characters because the whole envelope was
-- rewritten on every keystroke-level save. As rows they are read and written one
-- at a time, so the limits can be what a working repository actually needs
-- rather than what a single JSON document can carry.
--
-- Owner-scoped rather than per conversation: a coding workspace whose files
-- vanish when you start a new conversation is not a workspace. The path is part
-- of the key, so writing the same path twice replaces it, which is what a tool
-- called write_file should do.
CREATE TABLE workspace_files (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
);
CREATE INDEX workspace_files_by_user ON workspace_files (user_id, updated_at DESC);
