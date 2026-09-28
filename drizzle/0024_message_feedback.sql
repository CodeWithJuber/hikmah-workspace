-- Per-message thumbs up/down feedback for Chat v2.
--
-- LibreChat stores message feedback as `message.feedback` in Mongo and exposes
-- PUT /api/messages/:conversationId/:messageId/feedback; this is the same
-- shape expressed as a row, so rating is a keyed write rather than a re-render
-- of the whole message. One rating per message: rating again replaces, rating
-- null (see lib/chat/feedback-store.ts) clears.
CREATE TABLE message_feedback (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('up', 'down')),
  created_at TEXT NOT NULL
);
CREATE INDEX message_feedback_by_conversation ON message_feedback (conversation_id);
