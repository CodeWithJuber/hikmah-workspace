-- Gmail accounts, local drafts, and the send approval gate.
--
-- Follows the MCP conventions: credentials (OAuth tokens) are never stored in
-- these rows — they live in the encrypted workspace_secrets vault under a
-- `gmail:oauth` destination, and the account row only records which scopes
-- were actually granted. Every read/send/draft call names its account
-- explicitly; there is no default or primary account.

-- One connected Gmail account per owner. `scopes` is the space-joined list of
-- Google scopes Google actually granted (readonly, compose, send), recorded at
-- callback time and extended by incremental grants. `token_secret` is the
-- workspace-secrets name (GMAIL_OAUTH_<UPPER_HEX>) holding the refresh token.
CREATE TABLE gmail_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  token_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX gmail_accounts_owner ON gmail_accounts (user_id, email);

-- OAuth CSRF states. A state is bound to its owner and to the grant kind the
-- owner asked for, and dies ten minutes after it is issued: a callback that
-- arrives later, or for another owner, is refused.
CREATE TABLE gmail_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT,
  created_at TEXT NOT NULL
);

-- Local drafts. A draft is data in this database until the owner approves and
-- sends it — creating one never touches the Gmail API.
CREATE TABLE gmail_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES gmail_accounts (id) ON DELETE CASCADE,
  to_addrs TEXT NOT NULL DEFAULT '[]',
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX gmail_drafts_owner ON gmail_drafts (user_id, account_id);

-- Single-use send approvals. An approval is bound to the exact draft content
-- it approved (content_hash = sha256 of the canonical draft bytes): editing
-- the draft afterwards invalidates the approval, and a used or expired
-- approval authorizes nothing. This is the Gmail analogue of the MCP
-- fingerprint-bound consent.
CREATE TABLE gmail_send_approvals (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  draft_id TEXT NOT NULL REFERENCES gmail_drafts (id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Sent-mail idempotency log. The idempotency key is chosen by the caller (the
-- approve step returns one when the caller does not supply it) and is unique:
-- a retry with the same key returns the stored result instead of sending
-- again. A row is claimed as `sending` before the Gmail API is called, so a
-- crash between the call and the record still cannot double-send.
CREATE TABLE gmail_sent_log (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',
  gmail_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The send kill-switch. Off by default: connecting an account with send scope
-- still cannot send until the owner turns this on explicitly in Integrations.
-- GMAIL_SEND_FORCE_OFF=1 in the environment overrides it deployment-wide.
CREATE TABLE gmail_settings (
  user_id TEXT PRIMARY KEY,
  send_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
