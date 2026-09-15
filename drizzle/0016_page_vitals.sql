-- What the site actually feels like, on the devices people actually use.
--
-- There was no telemetry of any kind, which is why "the frontend hangs" had to
-- be reported by a person rather than observed. Every performance number in
-- this repo so far comes from a throttled Chromium in CI: useful for comparing
-- two builds, silent about a real phone on a real network.
--
-- First-party on purpose. A third-party analytics SDK would contradict the
-- privacy page, which says the work is not shared for advertising and that
-- nobody else sees it; this table is in the same SQLite file as everything
-- else and nothing leaves the deployment.
--
-- What is deliberately NOT here: no IP address, no user agent, no session id,
-- no referrer, no screen fingerprint. A row is a metric, a number, a route
-- template and a width bucket. user_id is nullable because the landing page
-- and the sign-in page are measured too, and a signed-out visitor has none.
--
-- Hand-written on purpose. server/storage.mjs applies drizzle/*.sql in lexical
-- order and pins each file's sha256, so a migration must never be edited after
-- it ships, and drizzle-kit generate must not be run against this directory.
CREATE TABLE page_vitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Null for a signed-out visitor. Set null rather than deleting the row when
  -- an account goes, so the performance history of a release survives.
  user_id TEXT,
  -- CLS, INP, LCP, FCP, TTFB. The route's template, never its parameters:
  -- '/chat/[id]', so a conversation id is never written here.
  route TEXT NOT NULL,
  metric TEXT NOT NULL,
  -- Milliseconds for every metric but CLS, which is unitless. Stored as REAL
  -- because CLS is a fraction and rounding it to an integer loses all of it.
  value REAL NOT NULL,
  -- web-vitals' own verdict: 'good' | 'needs-improvement' | 'poor'. Kept
  -- alongside the value so a threshold change upstream is visible rather than
  -- retroactively rewriting history.
  rating TEXT NOT NULL,
  -- 'phone' under 640px, 'desktop' at or above it. A bucket, not a size: the
  -- exact viewport is a fingerprint and is not worth having.
  width TEXT NOT NULL,
  -- Which build produced it, so a regression can be attributed to a release.
  release TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The one query this table exists for: how did metric X look on route Y over
-- the last N days, per release.
CREATE INDEX page_vitals_metric ON page_vitals (metric, route, created_at);
