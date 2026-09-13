-- Sentences from the owner's own chats that the co-model found hard.
--
-- The co-model is a dependency parser fitted on gold annotations, so it cannot
-- learn from a provider's answer: a chat reply carries no grammar to learn
-- from, and training it on its own parses would teach it to agree with itself.
-- What every chat can do is say which sentences it was least sure about. The
-- run already parses the owner's recent turns to build its context notes and
-- then discarded that measurement; this keeps it, so the studio can offer the
-- sentences worth annotating instead of asking the owner to invent examples.
--
-- One row per distinct sentence per language, so the same question asked twice
-- is one thing to review. `annotation` holds the model's own parse in the shape
-- the trainer accepts, which is what makes this a correction rather than an
-- annotation from nothing.
CREATE TABLE context_candidates (
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  -- The sentence normalised for comparison: NFC, collapsed spaces, lowercased.
  fingerprint TEXT NOT NULL,
  text TEXT NOT NULL,
  annotation TEXT NOT NULL,
  -- 0 confident, 1 lost. Stored rather than recomputed so the queue can be
  -- ordered by the database and the ranking a row was admitted under is the
  -- one it is read back by.
  uncertainty REAL NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Set when the owner has dealt with it, so a sentence is offered once.
  reviewed_at TEXT,
  PRIMARY KEY (user_id, language, fingerprint)
);

-- The queue read: one owner, one language, unreviewed, hardest first.
CREATE INDEX context_candidates_queue
  ON context_candidates (user_id, language, reviewed_at, uncertainty DESC);
