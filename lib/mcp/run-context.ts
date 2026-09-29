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
import { toRecord, type McpConsent, type McpStore } from './store.ts';

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
  /** The conversation the run belongs to, for conversation-scoped consents. */
  conversationId?: string;
  /**
   * Which servers this turn may need. Absent means every enabled server —
   * the historical behavior, kept so a caller that does not know the turn's
   * needs changes nothing. A turn that knows it needs nothing passes
   * `{ servers: [] }` and no server is handshaked at all; a turn that needs
   * specific servers names them and only those are connected.
   */
  scope?: McpScope;
  /** Injected by the tests. */
  connect?: typeof connectServer;
  /** Injected by the tests, so a suite does not pay the real deadline to prove
   * the deadline exists. */
  connectTimeoutMs?: number;
  /** Likewise, for the per-call deadline. */
  callTimeoutMs?: number;
};

/**
 * Which of the owner's servers one turn may need.
 *
 * The run layer decides relevance — it sees the turn — and this module only
 * enforces it, so a plain chat turn pays no handshake: no connection, no
 * credential decryption, no status churn on servers it never touched.
 */
export type McpScope = {
  /**
   * Server names to handshake, matched against the owner's enabled servers.
   * An empty list connects nothing. Names that are not enabled (or not known)
   * are skipped, never an error: a scope is a wish, not a demand.
   */
  servers: string[];
};

/**
 * Connect the enabled servers in scope and assemble the run's MCP tools.
 *
 * A server that fails to connect is recorded and skipped rather than failing the
 * run: one unreachable server should cost its own tools, not the conversation.
 */
export async function mcpRunTools(options: McpRunOptions): Promise<McpRunTools> {
  const connect = options.connect ?? connectServer;
  const rows = options.store.enabled(options.userId);
  // Selective capabilities (PR-08): only handshake the servers this turn may
  // need. Without a scope this is every enabled server, exactly as before;
  // with one — including the empty scope of a plain chat turn — anything
  // unnamed is never contacted.
  const scope = options.scope;
  const scoped = scope ? rows.filter((row) => scope.servers.includes(row.name)) : rows;
  if (scoped.length === 0) return EMPTY_MCP_TOOLS;

  // Every server at once. The sequential loop made the run wait up to N × the
  // per-server deadline before it had streamed a byte; now the wait is the
  // slowest server, not the sum. Each attempt is still bounded by
  // withDeadline — a hang is not a failure the catch below could see — and the
  // results are applied in row order afterwards, so tool order, statuses and
  // guidance read exactly as they did when the loop was sequential.
  const attempts = await Promise.allSettled(
    scoped.map((row) => {
      const record = toRecord(row);
      return withDeadline(
        connect(record, {
          secret: options.secret,
          signal: options.signal,
          bridge: options.bridge,
        }),
        record.name,
        options.signal,
        options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      );
    }),
  );

  const connected: ConnectedServer[] = [];
  const tools: ToolSet = {};
  const approval = new Map<string, ApprovalMode>();
  const changed: string[] = [];
  const guidance: { server: string; instructions: string }[] = [];

  attempts.forEach((attempt, index) => {
    // Row order, not settle order: the assembly below is deterministic and
    // identical to the old sequential loop's.
    const row = scoped[index];
    const record = toRecord(row);
    if (attempt.status === 'rejected') {
      const error = attempt.reason;
      options.store.setStatus(
        row.id,
        'failed',
        error instanceof Error ? error.message : 'Could not connect.',
      );
      return;
    }
    const server = attempt.value;
    connected.push(server);
    options.store.setStatus(row.id, 'connected', null);
    if (server.instructions)
      guidance.push({ server: record.name, instructions: server.instructions });

    const pins = options.store.pins(row.id);
    const consents = options.store.consents(row.id);
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
      // it has not been agreed to either. A changed one is the rug-pull case
      // and is reported.
      if (pinned && pinned !== fingerprint) changed.push(id);

      const decided = approvalFor(record, {
        name,
        annotations: (tool as { annotations?: Record<string, unknown> }).annotations,
      });
      // Consent, not discovery, decides. A pin records that this definition was
      // shown; it never approves. Auto-approval needs a bound consent for this
      // exact connector account, fingerprint and scope — or an explicit install
      // policy whose presented definition has not changed since. The first
      // sighting always asks; a hard deny is never offered, whatever consents
      // or grants remember.
      let gate: ApprovalMode = 'ask';
      if (decided === 'deny') gate = 'deny';
      else if (consentApplies(consents, name, fingerprint, options.conversationId)) gate = 'auto';
      else if (decided === 'auto' && pinned === fingerprint) gate = 'auto';

      if (gate === 'deny') continue;
      tools[id] = bounded(tool, id, options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS);
      approval.set(id, gate);
      if (!pinned) options.store.pin(row.id, name, fingerprint);
    }
  });

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
 * Does a bound consent cover this call? The account is the server row the
 * consents were read for; the tool name, the exact approved fingerprint and
 * the scope must all match. An unknown or empty fingerprint never consents.
 */
function consentApplies(
  consents: McpConsent[],
  toolName: string,
  fingerprint: string,
  conversationId?: string,
): boolean {
  if (!fingerprint) return false;
  const conversation = conversationId ?? '';
  return consents.some(
    (consent) =>
      consent.toolName === toolName &&
      consent.fingerprint === fingerprint &&
      (consent.scope === 'always' ||
        (consent.scope === 'conversation' &&
          consent.conversationId !== '' &&
          consent.conversationId === conversation)),
  );
}

/**
 * Turn the decisions into the per-tool approval map `ToolLoopAgent` takes.
 *
 * `'ask'` becomes `'user-approval'` so the run pauses and the owner answers,
 * which is the same path ssh_exec uses. Only `'auto'` — already resolved
 * against bound consents and the explicit install policy above — is approved.
 *
 * The grants argument is legacy: remembered tool ids are unbound by
 * construction (see lib/chat/approvals.ts), and an id alone must never
 * approve a tool, so they are not consulted here. Kept in the signature for
 * the existing call site.
 */
export function mcpToolApproval(
  approval: Map<string, ApprovalMode>,
  grants?: { tools: Set<string> },
) {
  void grants;
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
  let onAbort: (() => void) | undefined;
  // Set when the deadline or the abort wins the race while the attempt is
  // still in flight. When that attempt eventually settles, a server that
  // answered late is closed rather than left holding a socket for the life
  // of the worker. (The old `settled` flag could not do this: it was set by
  // the race branch whose .then was attached first, so it was already true
  // by the time the abandon handler ran and the late server was never
  // closed.)
  let lost = false;
  let closedLate = false;
  const abandon = (reason: string) => {
    lost = true;
    void work.then(
      (server) => {
        if (lost && !closedLate) {
          closedLate = true;
          void server.close().catch(() => {});
        }
      },
      () => {},
    );
    return new Error(reason);
  };
  // A turn that is already dead must not start a handshake it will abandon:
  // adding a listener to an already-aborted signal never fires, so without
  // this the attempt would run until the deadline.
  if (signal?.aborted) throw abandon(`Connecting to "${name}" was cancelled.`);
  try {
    return await Promise.race([
      work.then((server) => server),
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
        if (signal) {
          onAbort = () => reject(abandon(`Connecting to "${name}" was cancelled.`));
          // Detached in the finally below. Without this, every run left one
          // listener per server on a signal that can outlive the run — a slow
          // handle leak on the exact path PR-08 is asked to keep clean.
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The race is over: a listener left here would fire on a later abort and
    // reject a promise nobody is awaiting anymore. Removing an already-fired
    // (once:true) listener is a no-op.
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
