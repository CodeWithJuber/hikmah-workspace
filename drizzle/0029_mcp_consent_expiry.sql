-- PR-14: tool grants carry expiry.
--
-- `mcp_tool_consents` recorded when a grant was made but never when it stops
-- being one, so a grant was live until revoked or the fingerprint changed.
-- `expires_at` bounds that: a grant past its expiry authorizes nothing, and
-- the check happens at call time, not just when the grant is read for a run.
--
-- NULL means no expiry. Rows written before this column existed are
-- grandfathered as live-until-revoked-or-rotated: the migration cannot invent
-- a deadline the owner never chose, and silently expiring standing grants
-- would be a behavior change, not a policy.
--
-- The timestamp is ISO-8601 UTC, like `granted_at`. Comparisons are
-- fail-closed: an unparseable stamp, or a grant stamped in the future
-- relative to the checking clock, never authorizes.

ALTER TABLE mcp_tool_consents ADD COLUMN expires_at TEXT;
