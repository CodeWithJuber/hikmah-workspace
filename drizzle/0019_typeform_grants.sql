CREATE TABLE typeform_grants (
  owner_id TEXT NOT NULL,
  connection_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, user_id, form_id)
);
CREATE INDEX typeform_grants_user ON typeform_grants(user_id, connection_key);
