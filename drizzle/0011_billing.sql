-- Tiers and metered usage, for a deployment that has more than one person in it.
--
-- Two facts have to be answerable before a stranger can sign up: which tier a
-- person is on, and how much of the deployment's own provider budget they have
-- spent this month. Neither had anywhere to live.
--
-- `user_tiers` is deliberately sparse: a row exists only when someone has been
-- moved off the default, so the absence of a row is the free tier rather than a
-- state that has to be backfilled for every account that ever signs up.
CREATE TABLE user_tiers (
  user_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per finished run, written by the worker from the same figures the
-- answer already carries in its metadata. Recorded separately because a cap has
-- to be a SUM over an index, not a scan that parses a JSON column per message,
-- and because a message can be deleted while the spend it caused cannot be.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Whether the deployment paid for this. A run on the person's own key costs
  -- the deployment nothing and must not count against a managed allowance, but
  -- it is still worth recording so usage can be shown to them either way.
  metered INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX usage_events_user_created ON usage_events (user_id, created_at);
