-- Priority on the run queue, which the Pro plan has been claiming.
--
-- `claim()` took the oldest queued run — `ORDER BY created_at, id`, strict
-- FIFO with no notion of who was waiting. The plan sold "priority on the run
-- queue" and there was no column to hold one, so the sentence was untrue on
-- the landing page from the day it was written.
--
-- Higher wins, and 0 is the default so every run already queued keeps behaving
-- exactly as it did. The value is written at creation from the caller's tier
-- and stored on the row rather than read from their subscription at claim
-- time: a plan that changes while a run is waiting must not reorder work that
-- was already queued under the old one.
--
-- What this cannot do is worth writing down beside it: there is one worker and
-- it is busy-gated, so priority decides who is claimed *next*, never who is
-- interrupted. A long run already streaming still finishes first.
-- No matching edit in db/schema.ts, and that is not an oversight: the runs
-- family (runs, conversations, messages, run_events) has never been declared
-- there. Drizzle is schema-only in this project and no runtime query goes
-- through it — lib/runs/store.ts is raw node:sqlite — so declaring one table of
-- the four would read as the other three having been forgotten. The SQL here is
-- the record.
ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- The queue read is (status, priority, created_at) now, so the index that
-- serves it has to be too — otherwise the ordering is correct and the scan is
-- over every queued row.
DROP INDEX IF EXISTS runs_queue;
CREATE INDEX runs_queue ON runs (status, priority DESC, created_at);
