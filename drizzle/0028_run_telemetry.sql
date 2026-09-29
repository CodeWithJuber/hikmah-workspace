-- Run telemetry (PR-07): timed segments and machine-readable outcome codes.
--
-- `run_events` is a resume buffer — pruned at the end of every step — so it
-- cannot carry anything that must survive the run. Segment timings live here,
-- one row per segment, referenced to the run they measured. Nothing in these
-- rows may carry prompt text, tool arguments or keys: segments record names
-- and durations only, by construction of lib/runs/telemetry.ts.
CREATE TABLE run_telemetry (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  segment TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  reason_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX run_telemetry_by_run ON run_telemetry (run_id, created_at);

-- The latest machine-readable outcome of the run: completed, cancelled,
-- awaiting-approval, awaiting-answer, no-answer, budget-exhausted, timeout,
-- provider-error, internal-error, denied. Set alongside every status
-- transition (lib/runs/worker.ts), so a run's reason is queryable without
-- parsing its error sentence.
ALTER TABLE runs ADD COLUMN reason_code TEXT;
