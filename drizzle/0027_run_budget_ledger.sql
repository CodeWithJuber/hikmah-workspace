-- PR-04: durable per-run budget ledger. One row per run, created lazily on the
-- first provider dispatch. `spent_json` holds the settled {calls, tokens, cost};
-- the reservation itself is NOT persisted: it lives only in the ledger instance,
-- so a crashed dispatch evaporates with its process and a resumed run inherits
-- the settled spend, never a phantom reservation. `state` records the explicit
-- terminal exhaustion the last reserve observed ('active' while spending).
CREATE TABLE run_budget_ledger (
  run_id TEXT PRIMARY KEY,
  budget_json TEXT NOT NULL,
  spent_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);
