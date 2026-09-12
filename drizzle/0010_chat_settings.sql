-- Preferences for the chat surface, kept out of the workspace blob.
--
-- The blob (workspace_states) is guarded by a revision CAS, and a 409 makes the
-- workspace tab give up saving for the rest of its life. Two surfaces writing
-- it is therefore not a merge problem, it is a way to silently break the one
-- the owner has open. One row per owner here instead, last write wins: this is
-- one person on one machine, and a revision protocol would buy nothing but the
-- failure mode it is meant to prevent.
CREATE TABLE chat_settings (
  user_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
