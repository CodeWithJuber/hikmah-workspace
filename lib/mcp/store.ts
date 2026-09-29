/** Saved MCP servers, and the tool descriptions the owner has agreed to.
 *
 * Built on the raw `node:sqlite` handle for the same reasons as `lib/runs/store.ts`:
 * the D1-shaped shim re-prepares on every call and discards rows from
 * `RETURNING`. This module imports nothing from Next so it can be tested with a
 * bare in-memory database.
 */
import { DEFAULT_SERVERS } from './defaults.ts';
import { parseServerConfig, type McpServerConfig } from './config.ts';
import type { ApprovalMode, ServerRecord } from './manager.ts';
import type { SqliteHandle } from '../runs/store.ts';

export type McpServerRow = {
  id: string;
  user_id: string;
  name: string;
  config: string;
  enabled: number;
  trusted: number;
  approval: ApprovalMode;
  allow_tools: string | null;
  deny_tools: string | null;
  /** The owner chose this policy themselves (1) rather than inheriting the
   * seeded catalogue defaults (0). Only an explicit install policy can
   * consent to auto-approval; seeded trust is not the owner's decision. */
  consent_explicit: number;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export class McpStoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'McpStoreError';
    this.status = status;
  }
}

function patterns(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

/** A row as the manager wants it: parsed config, patterns as arrays. */
export function toRecord(row: McpServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config) as McpServerConfig,
    trusted: row.trusted === 1,
    approval: row.approval,
    allowTools: patterns(row.allow_tools),
    denyTools: patterns(row.deny_tools),
    consentExplicit: row.consent_explicit === 1,
  };
}

/** Everything the settings screen needs, and nothing a credential could hide in. */
export function publicServer(row: McpServerRow) {
  const config = JSON.parse(row.config) as McpServerConfig;
  return {
    id: row.id,
    name: row.name,
    // Headers can carry a resolved token, so only the shape of the connection
    // is reported: the URL or command, never the values sent with it.
    transport: config.type,
    target:
      config.type === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : config.url,
    enabled: row.enabled === 1,
    trusted: row.trusted === 1,
    approval: row.approval,
    allowTools: patterns(row.allow_tools) ?? [],
    denyTools: patterns(row.deny_tools) ?? [],
    status: row.status,
    lastError: row.last_error,
  };
}

const COLUMNS =
  'id, user_id, name, config, enabled, trusted, approval, allow_tools, deny_tools, consent_explicit, status, last_error, created_at, updated_at';

export function createMcpStore(
  db: SqliteHandle,
  options: { now?: () => string; newId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));

  const statements = {
    list: db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE user_id = ? ORDER BY name`),
    get: db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ? AND user_id = ?`),
    byName: db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE user_id = ? AND name = ?`),
    insert: db.prepare(
      `INSERT INTO mcp_servers (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE mcp_servers SET enabled = ?, trusted = ?, approval = ?, allow_tools = ?, deny_tools = ?,
       consent_explicit = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ),
    setStatus: db.prepare(
      'UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ),
    remove: db.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?'),
    pins: db.prepare('SELECT tool_name, hash FROM mcp_tool_pins WHERE server_id = ?'),
    pin: db.prepare(
      `INSERT INTO mcp_tool_pins (server_id, tool_name, hash, approved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (server_id, tool_name) DO UPDATE SET hash = excluded.hash, approved_at = excluded.approved_at`,
    ),
    unpin: db.prepare('DELETE FROM mcp_tool_pins WHERE server_id = ? AND tool_name = ?'),
    resetPins: db.prepare('DELETE FROM mcp_tool_pins WHERE server_id = ?'),
    consents: db.prepare(
      'SELECT tool_name, fingerprint, scope, conversation_id, granted_at FROM mcp_tool_consents WHERE server_id = ?',
    ),
    grantConsent: db.prepare(
      `INSERT INTO mcp_tool_consents (server_id, tool_name, fingerprint, scope, conversation_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, tool_name, scope, conversation_id)
       DO UPDATE SET fingerprint = excluded.fingerprint, granted_at = excluded.granted_at`,
    ),
    revokeConsent: db.prepare(
      'DELETE FROM mcp_tool_consents WHERE server_id = ? AND tool_name = ? AND scope = ? AND conversation_id = ?',
    ),
  };

  const store = {
    /**
     * List this owner's servers, seeding the catalogue on first use.
     *
     * Seeding here rather than in a migration keeps `drizzle/**` free of
     * per-user rows, and means a server added to the catalogue later reaches
     * existing owners instead of only new ones.
     */
    list(userId: string): McpServerRow[] {
      const existing = statements.list.all(userId) as McpServerRow[];
      const known = new Set(existing.map((row) => row.name));
      const missing = DEFAULT_SERVERS.filter((server) => !known.has(server.name));
      if (missing.length === 0) return existing;

      const stamp = now();
      for (const server of missing) {
        statements.insert.run(
          newId(),
          userId,
          server.name,
          JSON.stringify(server.config),
          server.enabled ? 1 : 0,
          server.trusted ? 1 : 0,
          'ask',
          null,
          null,
          0,
          server.enabled ? 'pending' : 'disabled',
          stamp,
          stamp,
        );
      }
      return statements.list.all(userId) as McpServerRow[];
    },

    get: (id: string, userId: string) =>
      (statements.get.get(id, userId) as McpServerRow | undefined) ?? undefined,

    enabled(userId: string): McpServerRow[] {
      return store.list(userId).filter((row) => row.enabled === 1);
    },

    /** Add a server from a pasted `.mcp.json` entry. */
    add(userId: string, name: string, config: unknown): McpServerRow {
      const trimmed = String(name ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed))
        throw new McpStoreError(
          'Use a short server name of letters, digits, dashes or underscores.',
        );
      if (statements.byName.get(userId, trimmed))
        throw new McpStoreError('A server with that name already exists.', 409);
      const parsed = parseServerConfig(config);
      const id = newId();
      const stamp = now();
      statements.insert.run(
        id,
        userId,
        trimmed,
        JSON.stringify(parsed),
        0,
        0,
        'ask',
        null,
        null,
        0,
        'disabled',
        stamp,
        stamp,
      );
      return store.get(id, userId)!;
    },

    /**
     * Change the owner's settings for a server.
     *
     * The config is deliberately not editable here: a server's URL or command is
     * what the owner agreed to when they added it, and silently repointing it
     * would carry the existing tool pins along with it.
     *
     * A policy change is an explicit owner decision, so it marks the policy
     * explicit (seeded defaults never auto-approve) and resets discovery: the
     * new policy's tools are presented again rather than inheriting pins from
     * a definition the owner agreed to under different terms. Enabling or
     * disabling alone changes nothing about what was shown.
     */
    update(
      id: string,
      userId: string,
      changes: {
        enabled?: boolean;
        trusted?: boolean;
        approval?: ApprovalMode;
        allowTools?: string[];
        denyTools?: string[];
      },
    ): McpServerRow {
      const existing = store.get(id, userId);
      if (!existing) throw new McpStoreError('That server is not saved here.', 404);
      const approval = changes.approval ?? existing.approval;
      if (!['auto', 'ask', 'deny'].includes(approval))
        throw new McpStoreError('Approval must be auto, ask or deny.');
      const enabled = changes.enabled ?? existing.enabled === 1;
      const trusted = changes.trusted ?? existing.trusted === 1;
      const allowTools = changes.allowTools
        ? JSON.stringify(changes.allowTools)
        : existing.allow_tools;
      const denyTools = changes.denyTools ? JSON.stringify(changes.denyTools) : existing.deny_tools;
      const samePatterns = (next: string | null, prev: string | null) =>
        JSON.stringify(patterns(next) ?? null) === JSON.stringify(patterns(prev) ?? null);
      const policyChanged =
        trusted !== (existing.trusted === 1) ||
        approval !== existing.approval ||
        !samePatterns(allowTools, existing.allow_tools) ||
        !samePatterns(denyTools, existing.deny_tools);
      statements.update.run(
        enabled ? 1 : 0,
        trusted ? 1 : 0,
        approval,
        allowTools,
        denyTools,
        policyChanged ? 1 : existing.consent_explicit,
        now(),
        id,
        userId,
      );
      // A changed policy re-presents the tools: pins recorded under the old
      // terms must not carry over, so the next run shows the current
      // definitions once before any auto-approval resumes.
      if (policyChanged) statements.resetPins.run(id);
      // A server switched off should not keep reporting the error it failed
      // with, and one switched on has not been tried yet.
      if (enabled !== (existing.enabled === 1))
        statements.setStatus.run(enabled ? 'pending' : 'disabled', null, now(), id);
      return store.get(id, userId)!;
    },

    setStatus: (id: string, status: string, error?: string | null) =>
      statements.setStatus.run(status, error ?? null, now(), id),

    remove: (id: string, userId: string) => statements.remove.run(id, userId),

    /** The tool hashes this owner has already seen and accepted. */
    pins(serverId: string): Map<string, string> {
      const rows = statements.pins.all(serverId) as { tool_name: string; hash: string }[];
      return new Map(rows.map((row) => [row.tool_name, row.hash]));
    },

    pin: (serverId: string, toolName: string, hash: string) =>
      statements.pin.run(serverId, toolName, hash, now()),

    unpin: (serverId: string, toolName: string) => statements.unpin.run(serverId, toolName),

    /**
     * Bound consents: explicit approved actions, each tied to the connector
     * account (server_id), the exact tool definition (fingerprint) and the
     * scope it was granted for. A definition change, a re-added connector
     * (new id) or a removed connector invalidates or deletes the row; the
     * tool id alone never grants.
     */
    consents(serverId: string): McpConsent[] {
      const rows = statements.consents.all(serverId) as {
        tool_name: string;
        fingerprint: string;
        scope: string;
        conversation_id: string;
        granted_at: string;
      }[];
      return rows.map((row) => ({
        toolName: row.tool_name,
        fingerprint: row.fingerprint,
        scope: row.scope as McpConsentScope,
        conversationId: row.conversation_id,
        grantedAt: row.granted_at,
      }));
    },

    /**
     * Record an explicit approved action. The fingerprint must be the
     * definition the owner actually saw when they approved; callers that do
     * not know it (the approval card today) cannot create a bound consent.
     */
    grantConsent(
      serverId: string,
      toolName: string,
      fingerprint: string,
      scope: McpConsentScope,
      conversationId = '',
    ): void {
      if (!toolName) throw new McpStoreError('A consent needs a tool name.');
      if (!/^[0-9a-f]{64}$/.test(fingerprint))
        throw new McpStoreError('A consent needs the approved tool fingerprint.');
      if (scope !== 'always' && scope !== 'conversation')
        throw new McpStoreError("Consent scope must be 'always' or 'conversation'.");
      if (scope === 'conversation' && !conversationId)
        throw new McpStoreError('A conversation-scoped consent needs its conversation.');
      statements.grantConsent.run(serverId, toolName, fingerprint, scope, conversationId, now());
    },

    revokeConsent(
      serverId: string,
      toolName: string,
      scope: McpConsentScope,
      conversationId = '',
    ): void {
      statements.revokeConsent.run(serverId, toolName, scope, conversationId);
    },
  };

  return store;
}

export type McpStore = ReturnType<typeof createMcpStore>;

/** One explicit approved action, bound to the definition it approved. */
export type McpConsentScope = 'always' | 'conversation';

export type McpConsent = {
  toolName: string;
  fingerprint: string;
  scope: McpConsentScope;
  /** Empty unless the scope is 'conversation'. */
  conversationId: string;
  grantedAt: string;
};
