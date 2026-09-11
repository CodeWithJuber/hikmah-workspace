/** Hosting stdio MCP servers on behalf of the app.
 *
 * Most MCP servers people install are run as a command — `npx -y
 * @modelcontextprotocol/server-filesystem`, `uvx mcp-server-fetch` — and the app
 * container cannot run any of them: it is read-only and installed with
 * --ignore-scripts, so there is no npx to invoke and nowhere to write a cache.
 * The workbench has both.
 *
 * So the workbench speaks streamable HTTP on the outside and stdio on the
 * inside. The app's MCP client connects to `/mcp/<id>` as an ordinary remote
 * server and never knows the difference, which means one transport in the
 * manager instead of two.
 *
 * The command to run arrives in a header rather than being registered
 * beforehand: registration state would go stale against a config the owner
 * edited, and anything holding the shared token can already run commands here
 * through `bash`, so this grants nothing new.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A child with nothing to do for this long is shut down. */
export const IDLE_TIMEOUT_MS = 5 * 60_000;
/** One server should not be able to hold the box with a runaway process. */
export const MAX_SERVERS = 8;
/** A single JSON-RPC message larger than this is not one we asked for. */
const MAX_MESSAGE_BYTES = 4_000_000;
/** How long to wait for a child to answer one request. */
export const REQUEST_TIMEOUT_MS = 60_000;

export class BridgeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

export type StdioConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** Read the server's command from the header the app sends it in. */
export function parseStdioConfig(header: string | undefined): StdioConfig {
  if (!header) throw new BridgeError('This request carries no MCP server configuration.');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new BridgeError('The MCP server configuration could not be read.');
  }
  const value = (raw ?? {}) as Record<string, unknown>;
  if (typeof value.command !== 'string' || !value.command.trim())
    throw new BridgeError('The MCP server configuration has no command.');
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new BridgeError('MCP server arguments must be strings.');
  const env = value.env ?? {};
  if (typeof env !== 'object' || env === null)
    throw new BridgeError('MCP server environment must be an object.');
  return {
    command: value.command,
    args: args as string[],
    env: Object.fromEntries(
      Object.entries(env as Record<string, unknown>)
        .filter(([, entry]) => typeof entry === 'string')
        .map(([key, entry]) => [key, entry as string]),
    ),
  };
}

/** Two configs are the same server only if they would run the same process. */
const fingerprint = (config: StdioConfig) =>
  JSON.stringify([config.command, config.args, Object.keys(config.env).sort()]);

type Child = {
  process: ChildProcessWithoutNullStreams;
  fingerprint: string;
  /** Resolvers for requests still waiting on an answer, by JSON-RPC id. */
  pending: Map<string | number, (message: unknown) => void>;
  idle: ReturnType<typeof setTimeout> | undefined;
  buffer: string;
};

export type BridgePool = ReturnType<typeof createBridgePool>;

export function createBridgePool(
  options: { idleMs?: number; spawnProcess?: typeof spawn; workspace?: string } = {},
) {
  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const children = new Map<string, Child>();

  /**
   * Stop a server.
   *
   * `only` guards against a stale handler: a replaced process still fires its
   * own exit, and without this it would take down whatever now holds its id —
   * including the replacement that just started.
   */
  function kill(id: string, only?: Child) {
    const child = children.get(id);
    if (!child || (only && child !== only)) return;
    children.delete(id);
    clearTimeout(child.idle);
    // Anything still waiting gets an answer rather than hanging until its own
    // timeout: the process it was waiting for is gone.
    for (const resolve of child.pending.values())
      resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'The MCP server stopped.' } });
    child.pending.clear();
    try {
      child.process.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  function touch(child: Child, id: string) {
    clearTimeout(child.idle);
    child.idle = setTimeout(() => kill(id, child), idleMs);
    (child.idle as unknown as { unref?: () => void }).unref?.();
  }

  function start(id: string, config: StdioConfig): Child {
    const existing = children.get(id);
    // A config the owner edited is a different server, so the old process is
    // replaced rather than answering with the previous server's tools.
    if (existing && existing.fingerprint !== fingerprint(config)) kill(id);
    else if (existing) return existing;

    if (children.size >= MAX_SERVERS)
      throw new BridgeError('Too many MCP servers are running here already.', 503);

    const process_ = spawnProcess(config.command, config.args, {
      cwd: options.workspace ?? process.env.HIKMAH_WORKSPACE_DIR ?? '/workspace',
      env: { ...process.env, ...config.env },
    }) as ChildProcessWithoutNullStreams;

    const child: Child = {
      process: process_,
      fingerprint: fingerprint(config),
      pending: new Map(),
      idle: undefined,
      buffer: '',
    };
    children.set(id, child);

    // stdio MCP is newline-delimited JSON, so a message is complete at a
    // newline and not before: a reply split across two reads must not be parsed
    // as two broken ones.
    process_.stdout.on('data', (chunk: Buffer) => {
      child.buffer += chunk.toString('utf8');
      if (child.buffer.length > MAX_MESSAGE_BYTES) {
        child.buffer = '';
        return;
      }
      let newline = child.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = child.buffer.slice(0, newline).trim();
        child.buffer = child.buffer.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: string | number };
            const resolve = message.id !== undefined && child.pending.get(message.id);
            if (resolve) {
              child.pending.delete(message.id!);
              resolve(message);
            }
          } catch {
            /* a line that is not JSON is the server's own noise, not a reply */
          }
        }
        newline = child.buffer.indexOf('\n');
      }
    });

    // A server's stderr is its log, not its protocol. Kept off stdout so one
    // chatty server cannot look like a malformed reply.
    process_.stderr.on('data', () => {});
    process_.on('error', () => kill(id, child));
    process_.on('exit', () => kill(id, child));
    touch(child, id);
    return child;
  }

  return {
    /** Send one JSON-RPC message and wait for its reply, if it expects one. */
    async call(id: string, config: StdioConfig, message: unknown): Promise<unknown | null> {
      const child = start(id, config);
      touch(child, id);
      const envelope = message as { id?: string | number };

      const written = child.process.stdin.write(JSON.stringify(message) + '\n');
      void written;
      // A notification carries no id and is never answered; waiting for a reply
      // to one would hang every call that follows it.
      if (envelope.id === undefined) return null;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.pending.delete(envelope.id!);
          resolve({
            jsonrpc: '2.0',
            id: envelope.id,
            error: { code: -32000, message: 'The MCP server did not answer in time.' },
          });
        }, REQUEST_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        child.pending.set(envelope.id!, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
      });
    },
    stop: (id: string) => kill(id),
    stopAll() {
      for (const id of [...children.keys()]) kill(id);
    },
    get size() {
      return children.size;
    },
  };
}

/** The `/mcp/<id>` path, or nothing when this is not a bridge request. */
export function bridgeServerId(url: string): string | null {
  const match = /^\/mcp\/([A-Za-z0-9_-]{1,64})(?:\?|$)/.exec(url);
  return match ? match[1] : null;
}

/** Answer one streamable-HTTP MCP request by relaying it to the child. */
export async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pool: BridgePool,
  body: unknown,
): Promise<void> {
  const id = bridgeServerId(request.url ?? '');
  const send = (status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  if (!id) return send(404, { error: 'Not found.' });

  let config: StdioConfig;
  try {
    config = parseStdioConfig((request.headers['x-hikmah-mcp'] as string | undefined) ?? undefined);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 400;
    return send(status, { error: error instanceof Error ? error.message : 'Bad request.' });
  }

  try {
    const reply = await pool.call(id, config, body);
    // A notification has no reply, and 202 is what the MCP HTTP transport
    // expects for one: returning an empty 200 body makes a client wait for JSON
    // that is never coming.
    if (reply === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    send(200, reply);
  } catch (error) {
    const status = error instanceof BridgeError ? error.status : 502;
    return send(status, { error: error instanceof Error ? error.message : 'The bridge failed.' });
  }
}
