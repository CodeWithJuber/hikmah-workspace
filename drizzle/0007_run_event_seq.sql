-- Sequence numbers must survive pruning.
--
-- A run's events are the resume buffer for the step in flight, and they are
-- pruned at the end of every step so a reconnecting client does not replay
-- chunks that are already a persisted message. The next sequence number was
-- derived from MAX(seq) over that table, so pruning restarted it at 0.
--
-- For a run that finishes in one step this is invisible. For a run that pauses
-- to ask the owner something and then resumes, it is not: the client is holding
-- a cursor from before the pause, every event after it arrives numbered below
-- that cursor, and both the server's replay and the client's own de-duplication
-- discard the entire second half of the answer. Silently.
--
-- The high-water mark therefore lives on the run, which is never pruned.
ALTER TABLE runs ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

-- Existing rows: start after whatever they already have, so a run that is
-- mid-flight across this upgrade does not reissue numbers it has already sent.
UPDATE runs
SET event_seq = COALESCE((SELECT MAX(seq) + 1 FROM run_events WHERE run_events.run_id = runs.id), 0);
