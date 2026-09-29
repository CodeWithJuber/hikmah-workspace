-- PR-02: bind MCP consent to the approved tool definition.
--
-- Two problems shared one table. `mcp_tool_pins` recorded that a tool
-- definition had been *seen*, and that same record then acted as approval on
-- the next run; meanwhile remembered grants were bare tool ids, so a
-- definition change could not invalidate them.
--
-- `consent_explicit` marks a server whose policy the owner chose themselves,
-- as opposed to seeded catalogue defaults. Only an explicit install policy
-- can consent to auto-approval: seeded trust is the catalogue's decision,
-- not the owner's.
--
-- `mcp_tool_consents` holds per-tool approved actions, bound to the connector
-- account (server_id), the exact definition (fingerprint) and the scope. A
-- changed definition, a re-added connector (new id) or a removed connector
-- invalidates or deletes the row. The tool id alone never grants.

ALTER TABLE mcp_servers ADD COLUMN consent_explicit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE mcp_tool_consents (
  server_id TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  scope TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL,
  PRIMARY KEY (server_id, tool_name, scope, conversation_id)
);
