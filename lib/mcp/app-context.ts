/** Wiring MCP to this deployment's storage and secrets.
 *
 * Separate from `run-context.ts` so that module stays testable against a bare
 * in-memory database, and separate from the run service so the worker does not
 * need to know how a credential is sealed.
 */
import { getStorage } from '../../server/storage.mjs';
import { createSecretStore } from '../../server/workspace-secrets.mjs';
import { MCP_SECRET_DESTINATION, referencedVariables } from './config.ts';
import { workbenchConfig } from '../ssh/client.ts';

import { createMcpStore } from './store.ts';
import { EMPTY_MCP_TOOLS, mcpRunTools, type McpRunTools } from './run-context.ts';

/**
 * Connect this owner's enabled servers for one run.
 *
 * `${VAR}` references are resolved up front rather than lazily: expansion is
 * synchronous inside the manager, and a run should fail to connect one server
 * rather than block on a decryption in the middle of assembling a tool set.
 */
export async function mcpForUser(userId: string, signal?: AbortSignal): Promise<McpRunTools> {
  const store = createMcpStore(getStorage().raw);
  const rows = store.enabled(userId);
  if (rows.length === 0) return EMPTY_MCP_TOOLS;

  const secrets = createSecretStore();
  const resolved = new Map<string, string>();
  // Only the names a server actually references are decrypted, so enabling one
  // server does not unseal every credential in the workspace.
  const wanted = new Set<string>();
  for (const row of rows)
    for (const name of referencedVariables(JSON.parse(row.config))) wanted.add(name);
  for (const name of wanted) {
    try {
      resolved.set(name, await secrets.resolve(userId, name, MCP_SECRET_DESTINATION, true));
    } catch {
      /* an optional credential the owner has not saved; the server may not need it */
    }
  }

  // Absent when there is no workbench, which is what makes a stdio server fail
  // with an explanation rather than a stack trace.
  let bridge: { url: string; token: string } | undefined;
  try {
    bridge = workbenchConfig();
  } catch {
    bridge = undefined;
  }

  return mcpRunTools({
    store,
    userId,
    secret: (name) => resolved.get(name),
    bridge,
    signal,
  });
}
