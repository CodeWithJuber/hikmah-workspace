-- The v5 control layer's learned state: the arm-selection policy, the
-- observed-outcome model, and the audit trail that makes both replayable.
--
-- The policy itself (LinUCB per arm) lives in lib/workflow/policy.ts; this
-- file is only its durable memory. Each arm keeps one row holding its
-- serialized {A, b} as a JSON blob — the matrices are small (feature dim
-- ~10), so a table per arm would be ceremony for no gain. The superadmin
-- policy-inspection view reads these rows directly.
CREATE TABLE workflow_policy (
  arm TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Observed terminal-outcome counts for the learned outcome model
-- (lib/workflow/outcomes.ts, v5 "Learned outcome model").
--
-- state_key is the state abstraction
-- (task_category, interpretation_known|unknown, evidence_available,
-- failure_observed), serialized by the caller. Only genuinely observed
-- outcomes are counted here — never predicted ones.
CREATE TABLE workflow_outcomes (
  state_key TEXT NOT NULL,
  arm TEXT NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (state_key, arm, outcome)
);

-- The feedback log. feedback_id is caller-supplied (one per run's final
-- outcome) and the PRIMARY KEY is the idempotency mechanism: a duplicate
-- feedback id is ignored by lib/workflow/store.ts, so the same outcome can
-- never update the policy twice. A replaced (superseded) feedback is handled
-- by replaying the event log — documented in store.ts, not built here.
CREATE TABLE workflow_feedback (
  feedback_id TEXT PRIMARY KEY,
  arm TEXT NOT NULL,
  reward_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every arm selection with its exact propensity, scores and feature version.
-- This is what makes a selection replayable and auditable: given the row, the
-- superadmin view can recompute exactly what the policy saw when it chose.
CREATE TABLE workflow_propensity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  propensity REAL NOT NULL,
  feature_version INTEGER NOT NULL,
  scores_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX workflow_propensity_run ON workflow_propensity (run_id);

-- Idempotency keys for lib/runs/enqueue.ts: the same key always resolves to
-- the same run id, so a retried or double-submitted request never starts a
-- second run. Claimed atomically with INSERT OR IGNORE.
CREATE TABLE run_idempotency (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
