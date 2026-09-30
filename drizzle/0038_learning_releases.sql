-- PR-25 learning release controls: versioned datasets, independent holdout
-- sets, staged canaries, approvals, and first-class rollback.
--
-- What a release is here: the learning pipeline already captures, reviews and
-- trains (lib/learning/). A release is the controlled rollout of one trained
-- candidate — propose → consent + version checks → owner approval → canary
-- stages (5% → 25% → 100%) with per-language metric gates → live — with
-- rollback as a first-class operation.
--
-- Additive tables only. Rollback deactivates a release; it never deletes
-- datasets, holdout sets, canary records or metrics rows. Deleting learned
-- evidence would destroy the audit trail a rollback is supposed to lean on.
--
-- learning_datasets: one row per dataset version. The version id is derived
-- from the sha256 of the canonical dataset content, so a dataset change
-- without a version bump is impossible to record — the gate refuses it.
-- consent_scope / consent_revision record the consent policy the data was
-- captured under; the release gate requires the CURRENT consent revision,
-- so revoked consent cannot silently ride an old dataset into production.
--
-- learning_holdout_sets: the INDEPENDENT holdout. Items here are never
-- trained on; the holdout split is deterministic by split_seed so any review
-- can reproduce exactly which items were held out.
--
-- learning_releases: the release ledger. status is one of
-- proposed | approved | canarying | live | superseded | rolled-back | rejected.
-- previous_release_id links a release to the one it supersedes, so a
-- rollback always knows what "the previous version" was.
--
-- learning_release_canaries: one row per canary stage attempt. metrics_json
-- carries per-language metrics on the holdout, provenance-labeled — never a
-- single blended score that could hide a regressing language.
--
-- learning_release_approvals: the owner's typed decisions with reasons.
CREATE TABLE learning_datasets (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  consent_scope TEXT NOT NULL,
  consent_revision INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  item_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX learning_datasets_by_language ON learning_datasets (language, created_at DESC);

CREATE TABLE learning_holdout_sets (
  id TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL REFERENCES learning_datasets (version),
  split_seed TEXT NOT NULL,
  items TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (dataset_version, split_seed)
);
CREATE INDEX learning_holdout_by_dataset ON learning_holdout_sets (dataset_version);

CREATE TABLE learning_releases (
  id TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL REFERENCES learning_datasets (version),
  status TEXT NOT NULL DEFAULT 'proposed',
  previous_release_id TEXT REFERENCES learning_releases (id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX learning_releases_by_status ON learning_releases (status, created_at DESC);

CREATE TABLE learning_release_canaries (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES learning_releases (id),
  stage TEXT NOT NULL,
  cohort_pct INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  metrics_json TEXT NOT NULL
);
CREATE INDEX learning_release_canaries_by_release ON learning_release_canaries (release_id, started_at);

CREATE TABLE learning_release_approvals (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES learning_releases (id),
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX learning_release_approvals_by_release ON learning_release_approvals (release_id, created_at);
