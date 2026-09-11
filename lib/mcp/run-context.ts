/** Bringing an owner's MCP servers into one run.
 *
 * Connecting is per run rather than pooled: a server's tool list and its
 * descriptions are part of the prompt, so they are re-read and re-checked each
 * time rather than cached into a state nobody re-approves.
 */
import type { ToolSet } from 'ai';
import {
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
  close: () => Promise<void>;
};

export const EMPTY_MCP_TOOLS: McpRunTools = {
  tools: {},
  approval: new Map(),
  changed: [],
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

  for (const row of rows) {
    const record = toRecord(row);
    let server: ConnectedServer;
    try {
      server = await connect(record, {
        secret: options.secret,
        signal: options.signal,
        bridge: options.bridge,
      });
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
      tools[id] = tool;
      approval.set(id, gate);
      if (!pinned) options.store.pin(row.id, name, fingerprint);
    }
  }

  return {
    tools,
    approval,
    changed,
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
