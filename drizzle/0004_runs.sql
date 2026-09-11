-- Server-owned runs.
--
-- Conversations previously lived inside one JSON blob per user in
-- workspace_states, rewritten in full every 1.5 seconds. A run lived in the
-- browser tab, so closing it ended the work. These tables move both to the
-- server: a conversation is rows, and a run is a record the server owns and can
-- resume after a restart.
--
-- Hand-written on purpose. server/storage.mjs applies drizzle/*.sql in lexical
-- order and pins each file's sha256, so a migration must never be edited after
-- it ships, and drizzle-kit generate must not be run against this directory.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'chat',
  model TEXT NOT NULL DEFAULT '',
  -- The run currently producing output, so a reopened tab knows what to
  -- re-attach to. Cleared when the run reaches a terminal state.
  active_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_by_user ON conversations (user_id, updated_at DESC);

-- One row per UIMessage. `parts` is the AI SDK part array, stored as written so
-- a reload reconstructs the transcript exactly, including tool calls and their
-- results rather than a flattened string.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_order ON messages (conversation_id, seq);

-- status is the whole lifecycle:
--   queued           waiting for the worker
--   running          claimed and producing output
--   waiting_approval paused until a human approves a tool call
--   done | failed | cancelled  terminal
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  step_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX runs_queue ON runs (status, created_at);
CREATE INDEX runs_by_conversation ON runs (conversation_id, created_at DESC);

-- The in-flight step, one row per streamed chunk, so a client that reconnects
-- can replay from the last sequence number it saw and then tail. Pruned when a
-- step completes and its messages are persisted: this is a resume buffer, not
-- an archive.
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
