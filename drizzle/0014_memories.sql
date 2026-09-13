-- Memories: what a person has saved, or the model has suggested, for later
-- answers to draw on. Their own table, at last.
--
-- Personal knowledge lived inside the workspace JSON blob (workspace_states),
-- which only the browser writes, under a revision CAS that permanently stops
-- the open workspace tab from saving if anything else writes it first. So no
-- server-side run could ever remember anything: the tool that suggested
-- memories went with the browser run loop, and nothing replaced it. This
-- table is the place a run can write to.
--
-- No full-text index here: a person keeps at most a few hundred of these, and
-- the in-memory retrieval over them (lib/playground/knowledge.ts) is enough.
-- The index is for messages, which are unbounded, and comes next.
--
-- Hand-written on purpose. server/storage.mjs applies drizzle/*.sql in lexical
-- order and pins each file's sha256, so a migration must never be edited after
-- it ships, and drizzle-kit generate must not be run against this directory.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- 'preference' travels with every answer; 'reference' only when the question
  -- shares its terms; 'episode' is reserved for what a run did, later.
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  -- The same text however it was spaced, cased or vowelled, so the same
  -- memory saved twice is one row with a higher count. See lib/text/normalise.
  content_key TEXT NOT NULL,
  -- Where it came from, which decides how far to trust it: 'quote' is the
  -- person's own words, 'source' was read from the named source, 'inference'
  -- is the model's own unverified conclusion. Only the first may ever be saved
  -- without review, and only for a preference.
  provenance TEXT NOT NULL DEFAULT 'quote',
  -- Human-readable: "You · <conversation>", a URL, "Added by you".
  source TEXT NOT NULL DEFAULT '',
  -- The conversation it was taken from, when it was taken from one, so a
  -- finished task can say how many memories it left to review.
  source_conversation_id TEXT,
  -- 'suggested' waits for the person; 'saved' is used; 'rejected' is kept so
  -- the same suggestion is not made again.
  status TEXT NOT NULL DEFAULT 'suggested',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX memories_dedup ON memories (user_id, kind, content_key);
CREATE INDEX memories_by_user ON memories (user_id, status, updated_at DESC);
CREATE INDEX memories_by_conversation ON memories (source_conversation_id);

-- One row per person whose blob knowledge has been copied across, written only
-- after the rows landed, so a failed import is retried and a finished one is
-- never repeated.
CREATE TABLE memory_imports (
  user_id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0
);
