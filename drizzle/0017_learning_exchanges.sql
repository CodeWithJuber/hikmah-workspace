-- An explicit opt-in, separate from running the local syntax compiler.
CREATE TABLE learning_policies (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  use_approved INTEGER NOT NULL DEFAULT 1,
  collect_syntax INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days IN (7, 30, 90)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE learning_examples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  correction TEXT,
  redactions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, run_id)
);
CREATE INDEX learning_examples_by_user ON learning_examples(user_id, created_at DESC);
CREATE INDEX learning_examples_by_review ON learning_examples(user_id, status, created_at DESC);

-- Old completed runs have no need to retain the decrypted provider credential.
-- Queued/paused runs retain it until terminal so a restart can still resume.
UPDATE runs SET config = json_remove(config, '$.apiKey')
WHERE status IN ('done', 'failed', 'cancelled') AND json_valid(config);
