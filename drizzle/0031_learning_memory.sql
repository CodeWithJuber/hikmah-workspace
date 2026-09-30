-- PR-18 learning memory: corrections stick, stale context expires, scoped memory.
--
-- Three additive columns on memories, none of them trusted blindly:
--
-- * supersedes — the id of the memory this row corrects. A correction is a
--   NEW row linked to the old one; the old row is never edited in place, so
--   the history survives and recall can prefer the newer fact. NULL means
--   this row corrects nothing.
-- * expires_at — an ISO timestamp after which the row is no longer recalled.
--   NULL means it does not expire. Retrieval treats expiry as a hard gate;
--   mere age is only a ranking decay (see lib/playground/knowledge.ts).
-- * scope — which project/workspace a memory belongs to. 'global' travels
--   everywhere; any other scope is recalled only when that scope is asked
--   for, so a fact learned in project A never leaks into project B.
--
-- The dedup index gains the scope: the same text may live once per scope,
-- and a correction is different text, so it never collides with what it
-- corrects. Existing rows keep scope 'global' and their dedup behaviour.
--
-- Hand-written on purpose, like 0014: server/storage.mjs applies drizzle/
-- *.sql in lexical order and pins each file's sha256, so this file must never
-- be edited after it ships.
ALTER TABLE memories ADD COLUMN supersedes TEXT;
ALTER TABLE memories ADD COLUMN expires_at TEXT;
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
DROP INDEX memories_dedup;
CREATE UNIQUE INDEX memories_dedup ON memories (user_id, scope, kind, content_key);
CREATE INDEX memories_by_scope ON memories (user_id, scope, status, updated_at DESC);
