-- WhatsApp Business channel: accounts, consent, templates, messages, webhook
-- ingestion and the send approval gate.
--
-- Follows the Gmail (0034) conventions: credentials (the Meta access token)
-- are never stored in these rows — they live in the encrypted
-- workspace_secrets vault under a `whatsapp:token` destination, and the
-- account row only records the vault name. Every send names its account
-- explicitly; there is no default or primary account.
--
-- Sending is disabled by default twice over: the per-owner switch in
-- whatsapp_settings starts off, and WHATSAPP_SEND_FORCE_OFF=1 in the
-- environment overrides it deployment-wide. Dry-run planning never needs
-- the switch; it builds the payload, writes a receipt, and never calls Meta.

-- One connected WhatsApp Business account per owner. `phone_number_id` is
-- Meta's id for the sending number; `token_secret` is the workspace-secrets
-- name holding the access token.
CREATE TABLE whatsapp_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  display_phone_number TEXT,
  business_account_id TEXT,
  token_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX whatsapp_accounts_owner ON whatsapp_accounts (user_id, phone_number_id);

-- Consent ledger. Consent-first: a number starts with no row (unknown), and
-- only explicit opt-in or an opt-out keyword changes state. `source` records
-- how the state was learned: 'api' (owner posted /api/whatsapp/optin),
-- 'webhook' (the user texted a STOP/START keyword), 'import' (owner-supplied
-- list — treated as opt-in only when the owner attests the user consented).
CREATE TABLE whatsapp_optins (
  user_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'api',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, phone)
);

-- Approved message templates, copied by the owner from the Meta dashboard.
-- `status` is what the owner says Meta approved: the send path only sends a
-- template outside the 24h session window when it is 'approved'.
CREATE TABLE whatsapp_templates (
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT REFERENCES whatsapp_accounts (id) ON DELETE SET NULL,
  language TEXT NOT NULL DEFAULT 'en_US',
  category TEXT NOT NULL DEFAULT 'utility',
  body TEXT NOT NULL DEFAULT '',
  variable_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, language, user_id)
);

-- Identity links: WhatsApp phone <-> workspace user. Links are explicit only:
-- the owner requests a code, reads it to the user out of band, and confirms
-- it. Inbound messages from unlinked numbers are recorded but never
-- attributed to a user.
CREATE TABLE whatsapp_identity_links (
  user_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at TEXT,
  linked_at TEXT,
  PRIMARY KEY (user_id, phone)
);

-- Every message we know about, inbound and outbound. `wamid` is Meta's
-- message id; a dry-run receipt has none because Meta never saw it.
-- `cost_estimate` is USD from the planning table in lib/whatsapp/cost.ts —
-- a planning estimate, not Meta's real rate card.
CREATE TABLE whatsapp_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT REFERENCES whatsapp_accounts (id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  wamid TEXT,
  phone TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  kind TEXT NOT NULL DEFAULT 'session',
  template_name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  body_preview TEXT NOT NULL DEFAULT '',
  cost_estimate REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX whatsapp_messages_wamid ON whatsapp_messages (wamid);
CREATE INDEX whatsapp_messages_owner ON whatsapp_messages (user_id, phone);

-- Raw signed webhook payloads, stored before anything is applied. The dedupe
-- key is what makes ingestion idempotent: Meta retries a delivery until we
-- 200 it, so the same event arriving twice must not double-apply.
CREATE TABLE whatsapp_webhook_events (
  dedupe_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT REFERENCES whatsapp_accounts (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX whatsapp_webhook_owner ON whatsapp_webhook_events (user_id, received_at);

-- Single-use send approvals, mirroring gmail_send_approvals. An approval is
-- bound to the exact message content it approved (content_hash = sha256 of
-- the canonical message bytes): editing afterwards invalidates the approval,
-- and a used or expired approval authorizes nothing.
CREATE TABLE whatsapp_send_approvals (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Sent-message idempotency log. A row is claimed as `sending` before Meta is
-- called, so a crash between the call and the record still cannot double
-- send; a retry with the same key returns the stored result.
CREATE TABLE whatsapp_sent_log (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES whatsapp_messages (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sending',
  meta_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The send kill-switch. Off by default: connecting an account still cannot
-- send until the owner turns this on explicitly in Integrations.
-- WHATSAPP_SEND_FORCE_OFF=1 in the environment overrides it deployment-wide.
CREATE TABLE whatsapp_settings (
  user_id TEXT PRIMARY KEY,
  send_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
