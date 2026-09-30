/** GitHub connections and their action receipts.
 *
 * Built on the raw `node:sqlite` handle like `lib/mcp/store.ts`, and importing
 * nothing from Next, so the store is testable with a bare in-memory database.
 * The token never lands here — it is kept in the encrypted secret store with
 * destination `github:<connectionId>`.
 */
import type { SqliteHandle } from '../runs/store.ts';
import { parseDeclaredScopes, type GitHubScopeId } from './scopes.ts';

export class GitHubStoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GitHubStoreError';
    this.status = status;
  }
}

export type GitHubConnectionRow = {
  id: string;
  user_id: string;
  label: string;
  scopes_declared: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type GitHubConnection = {
  id: string;
  label: string;
  scopes: GitHubScopeId[];
  status: 'connected' | 'needs-reauth' | 'disabled';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubReceipt = {
  id: string;
  connectionId: string;
  action: string;
  paramsHash: string;
  status: 'ok' | 'dry-run' | 'failed';
  resultSummary: string | null;
  dryRun: boolean;
  createdAt: string;
};

const CONNECTION_COLUMNS =
  'id, user_id, label, scopes_declared, status, last_error, created_at, updated_at';

const RECEIPT_COLUMNS =
  'id, user_id, connection_id, action, params_hash, status, result_summary, dry_run, created_at';

function toConnection(row: GitHubConnectionRow): GitHubConnection {
  let scopes: GitHubScopeId[] = [];
  try {
    scopes = parseDeclaredScopes(JSON.parse(row.scopes_declared));
  } catch {
    scopes = [];
  }
  const status =
    row.status === 'needs-reauth' || row.status === 'disabled' ? row.status : 'connected';
  return {
    id: row.id,
    label: row.label,
    scopes,
    status: status as GitHubConnection['status'],
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createGitHubStore(
  db: SqliteHandle,
  options: { now?: () => string; newId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));

  const statements = {
    list: db.prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM github_connections WHERE user_id = ? ORDER BY created_at`,
    ),
    get: db.prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM github_connections WHERE id = ? AND user_id = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO github_connections (${CONNECTION_COLUMNS}) VALUES (?, ?, ?, ?, 'connected', NULL, ?, ?)`,
    ),
    setStatus: db.prepare(
      'UPDATE github_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    setScopes: db.prepare(
      'UPDATE github_connections SET scopes_declared = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    remove: db.prepare('DELETE FROM github_connections WHERE id = ? AND user_id = ?'),
    removeReceipts: db.prepare('DELETE FROM github_receipts WHERE connection_id = ?'),
    insertReceipt: db.prepare(
      `INSERT INTO github_receipts (${RECEIPT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    receipts: db.prepare(
      `SELECT ${RECEIPT_COLUMNS} FROM github_receipts WHERE connection_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100`,
    ),
  };

  const store = {
    list(userId: string): GitHubConnection[] {
      return (statements.list.all(userId) as GitHubConnectionRow[]).map(toConnection);
    },

    get(id: string, userId: string): GitHubConnection | undefined {
      const row = statements.get.get(id, userId) as GitHubConnectionRow | undefined;
      return row ? toConnection(row) : undefined;
    },

    /** Record a new connection. The token is saved separately in the secret
     * store; this row only carries what the connect screen displayed. */
    add(userId: string, label: string, scopes: GitHubScopeId[]): GitHubConnection {
      const trimmed = String(label ?? '').trim();
      if (!trimmed) throw new GitHubStoreError('Name the connection so you can find it later.');
      const declared = parseDeclaredScopes(scopes);
      const id = newId();
      const stamp = now();
      statements.insert.run(
        id,
        userId,
        trimmed.slice(0, 80),
        JSON.stringify(declared),
        stamp,
        stamp,
      );
      return store.get(id, userId)!;
    },

    /** A scoped-auth failure leaves the connection usable after re-auth, so
     * the row survives — it only reports that it needs a fresh token. */
    markNeedsReauth(id: string, userId: string, error: string): void {
      statements.setStatus.run('needs-reauth', error, now(), id, userId);
    },

    markConnected(id: string, userId: string): void {
      statements.setStatus.run('connected', null, now(), id, userId);
    },

    /** Re-declaring scopes is a fresh onboarding of the same row: the old
     * token no longer matches what the screen shows, so the status goes back
     * to needing a token rather than silently keeping the old one's reach. */
    updateScopes(id: string, userId: string, scopes: GitHubScopeId[]): GitHubConnection {
      const existing = store.get(id, userId);
      if (!existing) throw new GitHubStoreError('That connection is not saved here.', 404);
      const declared = parseDeclaredScopes(scopes);
      statements.setScopes.run(JSON.stringify(declared), 'needs-reauth', now(), id, userId);
      return store.get(id, userId)!;
    },

    remove(id: string, userId: string): void {
      statements.removeReceipts.run(id);
      statements.remove.run(id, userId);
    },

    /** Append a receipt. Receipts are never updated or deleted through this
     * store — a receipt that changed after the fact would prove nothing. */
    recordReceipt(
      userId: string,
      connectionId: string,
      action: string,
      paramsHash: string,
      status: GitHubReceipt['status'],
      resultSummary: string | null,
      dryRun: boolean,
    ): GitHubReceipt {
      const id = newId();
      const stamp = now();
      statements.insertReceipt.run(
        id,
        userId,
        connectionId,
        action,
        paramsHash,
        status,
        resultSummary,
        dryRun ? 1 : 0,
        stamp,
      );
      return {
        id,
        connectionId,
        action,
        paramsHash,
        status,
        resultSummary,
        dryRun,
        createdAt: stamp,
      };
    },

    receipts(connectionId: string, userId: string): GitHubReceipt[] {
      return (
        statements.receipts.all(connectionId, userId) as {
          id: string;
          connection_id: string;
          action: string;
          params_hash: string;
          status: string;
          result_summary: string | null;
          dry_run: number;
          created_at: string;
        }[]
      ).map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        action: row.action,
        paramsHash: row.params_hash,
        status: row.status as GitHubReceipt['status'],
        resultSummary: row.result_summary,
        dryRun: row.dry_run === 1,
        createdAt: row.created_at,
      }));
    },
  };

  return store;
}

export type GitHubStore = ReturnType<typeof createGitHubStore>;
