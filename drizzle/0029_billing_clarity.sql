-- Usage and billing clarity (PR-15): consent before charge, failed-renewal
-- communication.
--
-- `billing_consents` records the exact terms a person agreed to before any
-- checkout opened: no charge without explicit consent at charge time, and the
-- consent itself kept where the app can show it without asking Stripe. One row
-- per agreement; agreeing again writes another row, so the history of what was
-- consented to is never rewritten.
CREATE TABLE billing_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  price_label TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL,
  agreed_at TEXT NOT NULL
);
CREATE INDEX billing_consents_user ON billing_consents (user_id, agreed_at);

-- `billing_events` is the billing page's memory of things the person should be
-- told: a renewal payment that failed, in particular. Stripe retries the card
-- for days (status `past_due`) before it gives up, and the tier stays paid
-- while it does — so the event, not the tier row, is what the notice renders
-- from. Rows are append-only; a redelivered webhook does not write a second
-- row for the same failure (see shouldRecordPaymentFailure).
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX billing_events_user_created ON billing_events (user_id, created_at);
