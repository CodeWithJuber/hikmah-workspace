-- Chat v2 conversation management: projects, pinning, project assignment.
--
-- projects are owner-scoped folders, the way LibreChat's Chat Projects work:
-- a conversation belongs to at most one, and deleting a project must not take
-- the conversations with it, so the reference is SET NULL.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_user_id_idx ON projects(user_id);

ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN project_id TEXT NULL
  REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX conversations_project_idx ON conversations(user_id, project_id);
