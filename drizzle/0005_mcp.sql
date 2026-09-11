-- MCP servers.
--
-- Replaces the previous design, where connections lived inside the workspace
-- JSON blob and a session bearer token was held only in React state and lost on
-- every reload. Servers are now rows, and their credentials are references into
-- the existing encrypted secret store rather than values.
--
-- `config` holds one entry of the de-facto .mcp.json shape that Claude Code,
-- Claude Desktop, Cursor and VS Code all converged on, so a user can paste a
-- snippet from any server's README and have it work:
--   {"type":"http","url":"https://...","headers":{"Authorization":"Bearer ${TOKEN}"}}
--   {"type":"stdio","command":"npx","args":["-y","pkg"],"env":{"KEY":"${VAL}"}}

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- A trusted server's read-only tools may run without a prompt. Untrusted
  -- servers always ask, whatever their tools claim about themselves.
  trusted INTEGER NOT NULL DEFAULT 0,
  approval TEXT NOT NULL DEFAULT 'ask',
  allow_tools TEXT,
  deny_tools TEXT,
  status TEXT NOT NULL DEFAULT 'disabled',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mcp_servers_name ON mcp_servers (user_id, name);

-- A tool's description is part of the prompt, so a server that changes it after
-- approval can redirect the model without the user seeing anything. Pinning the
-- hash makes that change visible and forces re-approval, which is the documented
-- defence against tool poisoning and rug-pull attacks.
CREATE TABLE mcp_tool_pins (
  server_id TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (server_id, tool_name)
);
