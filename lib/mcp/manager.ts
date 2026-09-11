/** Connects MCP servers and turns their tools into real model tools.
 *
 * The previous design gave the model two meta-tools, connector_catalog and
 * connector_call, and made it discover everything through them. That cost three
 * round-trips before any real work, truncated every description to 250
 * characters, declared arguments as a free-form object so the provider could not
 * validate them, and made per-tool permissions impossible. Here each MCP tool is
 * a first-class tool with its real schema.
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { createHash } from 'node:crypto';
import type { ToolSet } from 'ai';
import { expandVariables, type McpServerConfig } from './config.ts';

/** Tool ids follow the convention every MCP host uses, so allow-lists written
 * for one host read the same here, and two servers cannot collide. */
export const toolId = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** Parse `mcp__server__tool` back into its parts. */
export function parseToolId(id: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(id);
  return match ? { server: match[1], tool: match[2] } : null;
}

export type ApprovalMode = 'auto' | 'ask' | 'deny';

export type ServerRecord = {
  id: string;
  name: string;
  config: McpServerConfig;
  trusted: boolean;
  approval: ApprovalMode;
  allowTools?: string[];
  denyTools?: string[];
};

/** A tool's description is part of the prompt, so its identity must include it.
 * A server that quietly rewrites a description after approval can redirect the
 * model without the user seeing anything; pinning this hash makes that visible. */
export function toolFingerprint(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
}): string {
  return createHash('sha256')
    .update(tool.name)
    .update(' ')
    .update(tool.description ?? '')
    .update(' ')
    .update(JSON.stringify(tool.inputSchema ?? {}))
    .digest('hex');
}

/** Wildcards as in `mcp__github__list_*`, matching the host convention. */
export function matchesPattern(name: string, pattern: string): boolean {
  const parts = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + parts.join('.*') + '$').test(name);
}

/**
 * Decide how a tool call should be handled.
 *
 * Read-only hints are accepted only from a server the owner marked trusted,
 * because an annotation is supplied by the same server that supplies the tool:
 * treating it as authoritative would let any server opt itself out of approval.
 */
export function approvalFor(
  server: ServerRecord,
  tool: { name: string; annotations?: Record<string, unknown> },
): ApprovalMode {
  const id = toolId(server.name, tool.name);
  if (server.denyTools?.some((pattern) => matchesPattern(id, pattern))) return 'deny';
  if (server.approval === 'deny') return 'deny';
  if (server.allowTools?.some((pattern) => matchesPattern(id, pattern))) return 'auto';

  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.openWorldHint === true) return 'ask';
  if (server.trusted && annotations.readOnlyHint === true) return 'auto';
  return server.approval === 'auto' && server.trusted ? 'auto' : 'ask';
}

export type ConnectedServer = {
  server: ServerRecord;
  tools: ToolSet;
  fingerprints: Map<string, string>;
  close: () => Promise<void>;
};

export type ConnectOptions = {
  /** Resolves `${NAME}` from the encrypted secret store. */
  secret: (name: string) => string | undefined;
  signal?: AbortSignal;
  /**
   * Where to host a stdio server, when this deployment has a workbench.
   *
   * The app container cannot run one: it is read-only and installed with
   * --ignore-scripts, so there is no npx and nowhere to cache a download. The
   * workbench has both and speaks streamable HTTP on the outside, so a stdio
   * server reaches the client as an ordinary remote one.
   */
  bridge?: { url: string; token: string };
};

function resolveConfig(config: McpServerConfig, secret: ConnectOptions['secret']): McpServerConfig {
  if (config.type === 'stdio')
    return {
      ...config,
      command: expandVariables(config.command, secret),
      args: (config.args ?? []).map((arg) => expandVariables(arg, secret)),
      env: Object.fromEntries(
        Object.entries(config.env ?? {}).map(([key, value]) => [
          key,
          expandVariables(value, secret),
        ]),
      ),
    };
  return {
    ...config,
    url: expandVariables(config.url, secret),
    headers: Object.fromEntries(
      Object.entries(config.headers ?? {})
        .map(([key, value]) => [key, expandVariables(value, secret)])
        // An optional credential that resolved to nothing must not be sent as
        // an empty Authorization header, which some servers reject outright.
        .filter(([, value]) => value !== '' && value !== 'Bearer '),
    ),
  };
}

/** Connect one server and return its tools, namespaced. */
export async function connectServer(
  server: ServerRecord,
  options: ConnectOptions,
): Promise<ConnectedServer> {
  const config = resolveConfig(server.config, options.secret);

  let transport: { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
  if (config.type === 'stdio') {
    if (!options.bridge)
      throw new Error(
        `"${server.name}" runs as a command, which this container cannot do. Start the workbench service, or use a server with a URL.`,
      );
    transport = {
      type: 'http',
      url: `${options.bridge.url}/mcp/${encodeURIComponent(server.id)}`,
      headers: {
        authorization: `Bearer ${options.bridge.token}`,
        // The command travels with the request rather than being registered up
        // front, so an edited configuration cannot be served by a process
        // started from the previous one.
        'x-hikmah-mcp': Buffer.from(
          JSON.stringify({
            command: config.command,
            args: config.args ?? [],
            env: config.env ?? {},
          }),
        ).toString('base64'),
      },
    };
  } else {
    transport = { type: config.type, url: config.url, headers: config.headers };
  }

  const client = await createMCPClient({ transport });

  const discovered = await client.tools();
  const fingerprints = new Map<string, string>();
  const tools: ToolSet = {};
  for (const [name, tool] of Object.entries(discovered)) {
    const id = toolId(server.name, name);
    fingerprints.set(
      name,
      toolFingerprint({
        name,
        description: (tool as { description?: string }).description,
        inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
      }),
    );
    tools[id] = tool as ToolSet[string];
  }

  return {
    server,
    tools,
    fingerprints,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* the server may already be gone */
      }
    },
  };
}
