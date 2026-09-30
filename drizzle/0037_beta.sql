-- Commercial beta (PR-24): invitation cohort, trials, and the stub subscription
-- ledger.
--
-- `beta_invites` are the controlled cohort: the owner creates a single-use,
-- cohort-tagged, expiry-dated code and delivers it out-of-band (no email is
-- sent by this deployment — the code records the invitation, it does not
-- deliver it). `redeemed` is single-use: the redeem write only lands on an
-- `issued` row, so a double redeem fails.
--
-- `trials` are the honest 14-day trial: `expired` is a clock outcome, and a
-- trial NEVER auto-converts — `converted` is written only on the person's
-- explicit confirmation, because there is nothing to charge and therefore no
-- payment method to fall back on.
--
-- `subscriptions_stub` is the stub subscription ledger. EVERY money field is
-- $0 and says so: no payment provider is connected to this deployment. The
-- amount columns exist so the interface a real provider would implement
-- (lib/billing/provider-stub.ts) has a place to put a real amount later,
-- without this table ever pretending one was charged.
CREATE TABLE beta_invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  cohort TEXT NOT NULL DEFAULT 'beta-1',
  status TEXT NOT NULL DEFAULT 'issued',
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX beta_invites_code ON beta_invites (code);
CREATE INDEX beta_invites_email ON beta_invites (email);

CREATE TABLE trials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  converted_to TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX trials_user ON trials (user_id, started_at);

-- STUB: amount_cents is always 0 here; currency is informational only.
CREATE TABLE subscriptions_stub (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  last_receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX subscriptions_stub_user ON subscriptions_stub (user_id, created_at);
