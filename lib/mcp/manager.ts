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
  /**
   * The owner chose this policy themselves. Seeded catalogue defaults never
   * count: only an explicit install policy can consent to auto-approval.
   */
  consentExplicit?: boolean;
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
 *
 * Auto-approval additionally needs the owner's own explicit decision: a
 * seeded default is the catalogue's choice, not the owner's, so it never
 * consents. Explicitly written allow-patterns are the owner's words and
 * always count.
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
  if (!server.consentExplicit) return 'ask';
  if (server.trusted && annotations.readOnlyHint === true) return 'auto';
  return server.approval === 'auto' && server.trusted ? 'auto' : 'ask';
}

export type ConnectedServer = {
  server: ServerRecord;
  tools: ToolSet;
  fingerprints: Map<string, string>;
  /**
   * What the server says about using it, from the initialize handshake.
   *
   * The protocol has servers return this so a client can put it in the system
   * prompt, and it is the difference between a model that has fifteen Qur'an
   * tools available and a model that knows it must use them. Quran.com's says,
   * in as many words, never to answer from training data. We were discarding
   * it, which is the one thing this deployment could least afford to discard.
   */
  instructions: string;
  close: () => Promise<void>;
};

/**
 * How long a server has to shake hands and list its tools.
 *
 * There was no limit at all. `connectServer` awaited `createMCPClient` and then
 * `client.tools()`, and `run-context` catches a *failure* and skips the server —
 * but a hang is not a failure, it never returns. So one unresponsive server
 * held `mcpForUser` open, the run never started streaming, and the composer sat
 * on its stop button with nothing arriving. That is the "MCP stuck so the chat
 * is stuck, and there is an ✕ where Enter should be" report.
 *
 * Ten seconds is generous for a remote handshake plus a tools listing, and
 * short enough that a person waiting for an answer does not give up first.
 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long one `tools/call` may take before the run gives up on it.
 *
 * Bounding the connect only closed half the hole: a server that answers the
 * handshake and then hangs on a call stalls the run just as completely, and the
 * catch around the call never fires because a hang does not throw. A minute,
 * because a real tool may fetch a page, run a search or read a large document,
 * and cutting those off would break working servers to guard against broken
 * ones. On expiry the *tool* fails, not the run: the model is told and can say
 * so or try something else, which is what a person watching would want.
 */
export const MCP_CALL_TIMEOUT_MS = 60_000;

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

  // Bound the handshake: without this, a bridge URL that blackholes (DNS that
  // never answers, a firewall that drops packets) leaves connectServer pending
  // forever — and a test that expects the failure hangs the whole suite.
  let client;
  try {
    client = await createMCPClient({
      transport,
      initializationOptions: { timeout: MCP_CONNECT_TIMEOUT_MS },
    });
  } catch (error) {
    // A bare timeout/fetch error says nothing about *which* server failed.
    // Name it, so the failure is diagnosable where it surfaces.
    const where = (transport as { url?: string }).url;
    throw new Error(
      `could not reach MCP server "${server.name}"${where ? ` at ${where}` : ''}: ${String(error)}`,
      { cause: error },
    );
  }

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
    instructions: (client.instructions ?? '').trim(),
    close: async () => {
      try {
        await client.close();
      } catch {
        /* the server may already be gone */
      }
    },
  };
}
