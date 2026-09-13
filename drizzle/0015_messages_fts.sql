-- A full-text index over what people wrote and were told, so a run can recall
-- earlier conversations.
--
-- A run saw only its own conversation: `listMessages(run.conversation_id)`
-- and nothing else. Yesterday's chat was not forgotten, it was never in
-- reach. This is the index that puts it in reach — FTS5, BM25, no embeddings
-- and no model, so what is recalled can be explained by the words it shares.
--
-- Shape, chosen after reproducing the traps in node:sqlite:
--   * not contentless — a contentless FTS5 table cannot be told "delete rowid
--     N" without the original text, and passing '' corrupts the index;
--   * not external-content over `messages` — that table has a TEXT primary
--     key and no INTEGER PRIMARY KEY, so its rowids are not stable across
--     VACUUM. A standalone table that holds its own text is the safe shape.
--
-- What goes in: text parts only. Never a tool's output — a page read by
-- read_webpage would otherwise become a prompt-injection channel into every
-- later conversation. `user_id` is copied from `conversations` (messages has
-- none) so recall can never cross accounts.
--
-- `text` is what is matched: lower-cased, Arabic harakat and tatweel removed,
-- Urdu and Arabic letter forms folded — the same rules lib/text/normalise.ts
-- applies to the query, or the two could disagree about what a word is.
-- `original` is what is shown. The tokeniser keeps combining marks inside
-- words, so a Hindi virama does not split a word and a harakat could not have
-- either; NFKC is not available in SQL, and the rare presentation forms it
-- would fold are accepted as a miss.
--
-- If this deployment's SQLite lacked FTS5, applying this would throw at boot.
-- node:sqlite ships it; the container smoke applies every migration to a fresh
-- database before an image can ship, which is the assertion.
--
-- Hand-written on purpose. server/storage.mjs applies drizzle/*.sql in lexical
-- order and pins each file's sha256, so a migration must never be edited after
-- it ships, and drizzle-kit generate must not be run against this directory.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  original UNINDEXED,
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  user_id UNINDEXED,
  role UNINDEXED,
  tokenize = "unicode61 categories 'L* N* Co Mn Mc'"
);

-- The text parts of a message joined by a space, or NULL when it has none.
-- Written as a trigger body three times over rather than a function, which
-- SQLite does not have: the expression is the same in each.
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (text, original, message_id, conversation_id, user_id, role)
  SELECT
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace(replace(replace(replace(
          group_concat(json_extract(value, '$.text'), ' '),
          char(0x064B), ''), char(0x064C), ''), char(0x064D), ''), char(0x064E), ''),
          char(0x064F), ''), char(0x0650), ''), char(0x0651), ''), char(0x0652), ''),
          char(0x0670), ''), char(0x0640), ''),
          char(0x0643), char(0x06A9)), char(0x064A), char(0x06CC)), char(0x0649), char(0x06CC)),
          char(0x0623), char(0x0627)), char(0x0625), char(0x0627)), char(0x0622), char(0x0627)),
          char(0x0629), char(0x0647))),
    group_concat(json_extract(value, '$.text'), ' '),
    new.id,
    new.conversation_id,
    (SELECT user_id FROM conversations WHERE id = new.conversation_id),
    new.role
  FROM json_each(new.parts)
  WHERE json_extract(value, '$.type') = 'text'
  HAVING count(*) > 0;
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

-- An answer is saved once as a row and then updated in place when a resumed
-- run finishes it, so the index has to follow the update.
CREATE TRIGGER messages_fts_update AFTER UPDATE OF parts ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts (text, original, message_id, conversation_id, user_id, role)
  SELECT
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace(replace(replace(replace(
          group_concat(json_extract(value, '$.text'), ' '),
          char(0x064B), ''), char(0x064C), ''), char(0x064D), ''), char(0x064E), ''),
          char(0x064F), ''), char(0x0650), ''), char(0x0651), ''), char(0x0652), ''),
          char(0x0670), ''), char(0x0640), ''),
          char(0x0643), char(0x06A9)), char(0x064A), char(0x06CC)), char(0x0649), char(0x06CC)),
          char(0x0623), char(0x0627)), char(0x0625), char(0x0627)), char(0x0622), char(0x0627)),
          char(0x0629), char(0x0647))),
    group_concat(json_extract(value, '$.text'), ' '),
    new.id,
    new.conversation_id,
    (SELECT user_id FROM conversations WHERE id = new.conversation_id),
    new.role
  FROM json_each(new.parts)
  WHERE json_extract(value, '$.type') = 'text'
  HAVING count(*) > 0;
END;

-- Every message already stored, so recall reaches back before this shipped.
INSERT INTO messages_fts (text, original, message_id, conversation_id, user_id, role)
SELECT
  lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(
        t.joined,
        char(0x064B), ''), char(0x064C), ''), char(0x064D), ''), char(0x064E), ''),
        char(0x064F), ''), char(0x0650), ''), char(0x0651), ''), char(0x0652), ''),
        char(0x0670), ''), char(0x0640), ''),
        char(0x0643), char(0x06A9)), char(0x064A), char(0x06CC)), char(0x0649), char(0x06CC)),
        char(0x0623), char(0x0627)), char(0x0625), char(0x0627)), char(0x0622), char(0x0627)),
        char(0x0629), char(0x0647))),
  t.joined,
  t.id,
  t.conversation_id,
  c.user_id,
  t.role
FROM (
  SELECT m.id, m.conversation_id, m.role,
         (SELECT group_concat(json_extract(value, '$.text'), ' ')
            FROM json_each(m.parts)
           WHERE json_extract(value, '$.type') = 'text') AS joined
    FROM messages m
) t
JOIN conversations c ON c.id = t.conversation_id
WHERE t.joined IS NOT NULL AND t.joined <> '';
