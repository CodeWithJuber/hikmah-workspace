-- Automatic syntax training is a separate explicit opt-in. Existing consent
-- does not authorize the bounded additional requests to a model provider.
ALTER TABLE learning_policies ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;

CREATE TABLE automatic_learning_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  example_id TEXT NOT NULL REFERENCES learning_examples(id) ON DELETE CASCADE,
  consent_revision INTEGER NOT NULL,
  language TEXT NOT NULL,
  sentences TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT NOT NULL DEFAULT '',
  requested_at TEXT,
  annotations TEXT,
  checkpoint_id TEXT,
  receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, example_id)
);
CREATE INDEX automatic_learning_queue ON automatic_learning_jobs(status, created_at);
CREATE INDEX automatic_learning_user ON automatic_learning_jobs(user_id, created_at DESC);

-- Request reservations survive deleting the source conversation or learning
-- examples, so clearing history cannot reset the daily provider budget.
CREATE TABLE automatic_learning_budget (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day)
);

CREATE TABLE automatic_learning_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE automatic_learning_annotations (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  example_id TEXT NOT NULL REFERENCES learning_examples(id) ON DELETE CASCADE,
  annotation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, language, fingerprint)
);

-- Removing a checkpoint row must not lose a failed object deletion. Cleanup is
-- retried by the background service without retaining the training source.
CREATE TABLE automatic_learning_garbage (blob_key TEXT PRIMARY KEY, holder TEXT);
