-- Agents: a named bundle of instructions and a tool set.
--
-- They lived in the workspace JSON blob, which meant an agent belonged to a
-- browser rather than to the owner, and a run driven by the server could not see
-- one. As rows the server can apply an agent to a run, which is the only place
-- it has ever needed to be applied.
--
-- `tools` is an allowlist over the built-in tool names, stored as JSON because
-- it is read whole and never queried by element. `built_in` marks the seeded
-- templates so they can be refreshed without overwriting an owner's own.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  -- Empty means every tool the run would otherwise offer, which is what an
  -- agent that only changes the instructions should do.
  tools TEXT NOT NULL DEFAULT '[]',
  -- Optional. An agent that names no model runs on whatever the conversation is
  -- already using, so picking one does not silently change the provider.
  model TEXT NOT NULL DEFAULT '',
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agents_by_user ON agents (user_id, name);
