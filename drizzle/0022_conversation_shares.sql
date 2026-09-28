-- Chat v2 read-only conversation shares.
--
-- Only the sha256 of the token is stored: the plaintext link lives in the
-- owner's clipboard (and the dialog), never in the database. The token is 32
-- random bytes in base64url, so it is unguessable by construction; the row is
-- the capability. Revoking stamps revoked_at rather than deleting, so a later
-- audit can tell a dead link from one that never existed.
CREATE TABLE conversation_shares (
  token_hash TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NULL
);
CREATE INDEX conversation_shares_conversation_idx ON conversation_shares(conversation_id);
