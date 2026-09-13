/** Bringing an owner's MCP servers into one run.
 *
 * Connecting is per run rather than pooled: a server's tool list and its
 * descriptions are part of the prompt, so they are re-read and re-checked each
 * time rather than cached into a state nobody re-approves.
 */
import type { ToolSet } from 'ai';
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  approvalFor,
  connectServer,
  parseToolId,
  toolFingerprint,
  type ApprovalMode,
  type ConnectedServer,
} from './manager.ts';
import { toRecord, type McpStore } from './store.ts';

/** What a run gets: the tools, how each is gated, and how to let go of them. */
export type McpRunTools = {
  tools: ToolSet;
  /** Tool id to the decision the policy reached, for `toolApproval`. */
  approval: Map<string, ApprovalMode>;
  /** Tool ids whose description changed since the owner last saw it. */
  changed: string[];
  /**
   * What each connected server says about using it, to be added to the system
   * prompt. Named per server, because a model given fifteen tools and no word
   * about when they are authoritative will answer from memory instead.
   */
  guidance: { server: string; instructions: string }[];
  close: () => Promise<void>;
};

export const EMPTY_MCP_TOOLS: McpRunTools = {
  tools: {},
  approval: new Map(),
  changed: [],
  guidance: [],
  close: async () => {},
};

export type McpRunOptions = {
  store: McpStore;
  userId: string;
  /** Resolves `${NAME}` from the encrypted secret store, synchronously. */
  secret: (name: string) => string | undefined;
  signal?: AbortSignal;
  /** Where stdio servers are hosted, when this deployment has a workbench. */
  bridge?: { url: string; token: string };
  /** Injected by the tests. */
  connect?: typeof connectServer;
  /** Injected by the tests, so a suite does not pay the real deadline to prove
   * the deadline exists. */
  connectTimeoutMs?: number;
  /** Likewise, for the per-call deadline. */
  callTimeoutMs?: number;
};

/**
 * Connect every enabled server and assemble the run's MCP tools.
 *
 * A server that fails to connect is recorded and skipped rather than failing the
 * run: one unreachable server should cost its own tools, not the conversation.
 */
export async function mcpRunTools(options: McpRunOptions): Promise<McpRunTools> {
  const connect = options.connect ?? connectServer;
  const rows = options.store.enabled(options.userId);
  if (rows.length === 0) return EMPTY_MCP_TOOLS;

  const connected: ConnectedServer[] = [];
  const tools: ToolSet = {};
  const approval = new Map<string, ApprovalMode>();
  const changed: string[] = [];
  const guidance: { server: string; instructions: string }[] = [];

  for (const row of rows) {
    const record = toRecord(row);
    let server: ConnectedServer;
    try {
      // Bounded. `connectServer` awaits a handshake and then a tools listing
      // with no limit of its own, and the catch below only sees a *failure* —
      // a hang never returns. So one unresponsive server held the whole run
      // open before it had streamed a byte, and the composer sat on its stop
      // button with nothing arriving. Here rather than inside connectServer so
      // that any connect implementation is bounded, the tests' included.
      server = await withDeadline(
        connect(record, {
          secret: options.secret,
          signal: options.signal,
          bridge: options.bridge,
        }),
        record.name,
        options.signal,
        options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      );
    } catch (error) {
      options.store.setStatus(
        row.id,
        'failed',
        error instanceof Error ? error.message : 'Could not connect.',
      );
      continue;
    }
    connected.push(server);
    options.store.setStatus(row.id, 'connected', null);
    if (server.instructions)
      guidance.push({ server: record.name, instructions: server.instructions });

    const pins = options.store.pins(row.id);
    for (const [id, tool] of Object.entries(server.tools)) {
      const name = parseToolId(id)?.tool ?? id;
      const fingerprint =
        server.fingerprints.get(name) ??
        toolFingerprint({
          name,
          description: (tool as { description?: string }).description,
          inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
        });
      const pinned = pins.get(name);

      // A description the owner has not seen is not automatically hostile, but
      // it has not been agreed to either: it may be auto-approved only once it
      // has been. A changed one is the rug-pull case and is reported.
      if (pinned && pinned !== fingerprint) changed.push(id);

      const decided = approvalFor(record, {
        name,
        annotations: (tool as { annotations?: Record<string, unknown> }).annotations,
      });
      const gate: ApprovalMode =
        pinned === fingerprint ? decided : decided === 'deny' ? 'deny' : 'ask';

      if (gate === 'deny') continue;
      tools[id] = bounded(tool, id, options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS);
      approval.set(id, gate);
      if (!pinned) options.store.pin(row.id, name, fingerprint);
    }
  }

  return {
    tools,
    approval,
    changed,
    guidance,
    close: async () => {
      await Promise.all(connected.map((server) => server.close()));
    },
  };
}

/**
 * Turn the decisions into the per-tool approval map `ToolLoopAgent` takes.
 *
 * `'ask'` becomes `'user-approval'` so the run pauses and the owner answers,
 * which is the same path ssh_exec uses.
 */
export function mcpToolApproval(approval: Map<string, ApprovalMode>) {
  return Object.fromEntries(
    [...approval].map(([id, mode]) => [id, mode === 'auto' ? 'approved' : 'user-approval']),
  );
}

/**
 * The same tool, but its calls cannot run forever.
 *
 * Connecting is bounded a few lines above; calling was not. A server that
 * completes its handshake and then never answers a `tools/call` holds the run
 * open exactly as a dead one did — and it is the likelier failure, because a
 * server has to be reachable to be used at all.
 *
 * The rejection becomes an ordinary tool error, so the model sees "this tool
 * did not answer" and can say so or do something else. Failing the whole run
 * would throw away every step that had already succeeded.
 */
function bounded<T>(tool: T, id: string, limit: number): T {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== 'function') return tool;
  return {
    ...(tool as object),
    execute: async (...args: unknown[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (execute as (...a: unknown[]) => Promise<unknown>)(...args),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(Error(`"${id}" did not answer within ${Math.round(limit / 1000)} seconds.`)),
              limit,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  } as T;
}

/**
 * A connection attempt with a time limit and an abort.
 *
 * When the limit wins the attempt is still in flight, so a server that answers
 * late is closed rather than left holding a socket for the life of the worker.
 */
async function withDeadline(
  work: Promise<ConnectedServer>,
  name: string,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<ConnectedServer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const abandon = (reason: string) => {
    void work.then(
      (server) => {
        if (!settled) void server.close().catch(() => {});
      },
      () => {},
    );
    return new Error(reason);
  };
  try {
    return await Promise.race([
      work.then((server) => {
        settled = true;
        return server;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              abandon(
                `"${name}" did not answer within ${Math.round(limit / 1000)} seconds. Its tools are not available for this run.`,
              ),
            ),
          limit,
        );
        signal?.addEventListener(
          'abort',
          () => reject(abandon(`Connecting to "${name}" was cancelled.`)),
          {
            once: true,
          },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
