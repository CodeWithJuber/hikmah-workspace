-- Message branching: a tree over messages, with the active path materialized
-- for the linear pipeline.
--
-- `parent_id` links each message to the message it answers. The conversation's
-- original linear history is a degenerate tree: every row has parent_id NULL
-- (or chains through one parent), and on_active_path = 1 everywhere — so a
-- conversation that has never been branched behaves exactly as before.
--
-- `on_active_path` marks the single root-to-leaf path the worker and the
-- transcript read. Editing a message creates a sibling on the path and
-- switches the old message's subtree off it; switching branches flips the
-- flags in one transaction. listMessages gains `AND on_active_path = 1` so
-- the prompt builder keeps working unchanged.
--
-- Hand-written on purpose: never edited after shipping, like every migration
-- in this directory (see drizzle/0004_runs.sql).

ALTER TABLE messages ADD COLUMN parent_id TEXT NULL REFERENCES messages (id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN on_active_path INTEGER NOT NULL DEFAULT 1;
CREATE INDEX messages_branch ON messages (conversation_id, parent_id);
