-- Task continuity (PR-16b): reload-safe state for background learning tasks.
--
-- One row per task conversation: the idempotency key that makes task creation
-- retry-safe (UNIQUE per owner, so a retried POST replays the same task
-- instead of dispatching a duplicate run and spending twice), the idempotent
-- disambiguation prompts (asked once across reloads — a reload re-renders the
-- same prompt rather than creating a new one), the recorded outcome, and the
-- append-only audit trail that the no-silent-replacement rule requires.
-- Prompts, outcome and audit are JSON columns: read whole, never queried by
-- element (same shape as agents.tools).
CREATE TABLE task_continuity (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  idempotency_key TEXT,
  run_id TEXT,
  prompts TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  audit TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The dedupe arbiter: two POSTs with the same key race, the loser sees the
-- unique violation and replays the winner instead of dispatching a duplicate.
-- Partial so tasks started without a key (older clients) are unaffected.
CREATE UNIQUE INDEX task_continuity_owner_key ON task_continuity (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX task_continuity_by_run ON task_continuity (run_id) WHERE run_id IS NOT NULL;
