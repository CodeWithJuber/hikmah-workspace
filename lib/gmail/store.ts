/** Gmail accounts, drafts, send approvals and the idempotency log.
 *
 * Built on the raw `node:sqlite` handle like `lib/mcp/store.ts`, for the same
 * reason: this module imports nothing from Next so it can be tested with a
 * bare in-memory database. OAuth tokens never touch these tables — they live
 * in the encrypted workspace_secrets vault, and the account row only records
 * the granted scopes and the secret's name.
 */
import { createHash } from 'node:crypto';
import type { SqliteHandle } from '../runs/store.ts';

export class GmailStoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GmailStoreError';
    this.status = status;
  }
}

export type GmailAccountRow = {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  scopes: string;
  token_secret: string;
  created_at: string;
  updated_at: string;
};

export type GmailAccount = {
  id: string;
  email: string;
  displayName: string | null;
  scopes: string;
  tokenSecret: string;
};

export type GmailDraftRow = {
  id: string;
  user_id: string;
  account_id: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  created_at: string;
  updated_at: string;
};

export type GmailDraft = {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
};

/** The exact bytes an approval covers: To, Cc, Subject, body, In-Reply-To. */
export function draftContentHash(draft: {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: draft.inReplyTo,
      }),
    )
    .digest('hex');
}

/** sha256 of a single-use approval token; the token itself is never stored. */
export function approvalTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseAddrs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toDraft(row: GmailDraftRow): GmailDraft {
  return {
    id: row.id,
    accountId: row.account_id,
    to: parseAddrs(row.to_addrs),
    cc: parseAddrs(row.cc_addrs),
    subject: row.subject,
    body: row.body,
    inReplyTo: row.in_reply_to,
  };
}

const ACCOUNT_COLUMNS =
  'id, user_id, email, display_name, scopes, token_secret, created_at, updated_at';
const DRAFT_COLUMNS =
  'id, user_id, account_id, to_addrs, cc_addrs, subject, body, in_reply_to, created_at, updated_at';

export function createGmailStore(
  db: SqliteHandle,
  options: { now?: () => string; newId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));

  const statements = {
    accounts: db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM gmail_accounts WHERE user_id = ? ORDER BY email`,
    ),
    account: db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM gmail_accounts WHERE id = ? AND user_id = ?`,
    ),
    accountByEmail: db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM gmail_accounts WHERE user_id = ? AND email = ?`,
    ),
    insertAccount: db.prepare(
      `INSERT INTO gmail_accounts (${ACCOUNT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateAccount: db.prepare(
      'UPDATE gmail_accounts SET display_name = ?, scopes = ?, token_secret = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    deleteAccount: db.prepare('DELETE FROM gmail_accounts WHERE id = ? AND user_id = ?'),
    insertState: db.prepare(
      'INSERT INTO gmail_oauth_states (state, user_id, kind, account_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    oauthState: db.prepare(
      'SELECT state, user_id, kind, account_id, created_at FROM gmail_oauth_states WHERE state = ?',
    ),
    deleteState: db.prepare('DELETE FROM gmail_oauth_states WHERE state = ?'),
    pruneStates: db.prepare('DELETE FROM gmail_oauth_states WHERE created_at < ?'),
    drafts: db.prepare(
      `SELECT ${DRAFT_COLUMNS} FROM gmail_drafts WHERE user_id = ? AND account_id = ? ORDER BY updated_at DESC`,
    ),
    draft: db.prepare(`SELECT ${DRAFT_COLUMNS} FROM gmail_drafts WHERE id = ? AND user_id = ?`),
    insertDraft: db.prepare(
      `INSERT INTO gmail_drafts (${DRAFT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateDraft: db.prepare(
      'UPDATE gmail_drafts SET to_addrs = ?, cc_addrs = ?, subject = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    deleteDraft: db.prepare('DELETE FROM gmail_drafts WHERE id = ? AND user_id = ?'),
    insertApproval: db.prepare(
      `INSERT INTO gmail_send_approvals
       (token_hash, user_id, account_id, draft_id, content_hash, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ),
    approval: db.prepare(
      'SELECT token_hash, user_id, account_id, draft_id, content_hash, created_at, expires_at, used_at FROM gmail_send_approvals WHERE token_hash = ?',
    ),
    useApproval: db.prepare(
      'UPDATE gmail_send_approvals SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
    ),
    claimSend: db.prepare(
      `INSERT INTO gmail_sent_log
       (idempotency_key, user_id, account_id, draft_id, status, gmail_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sending', NULL, ?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    ),
    sentEntry: db.prepare(
      'SELECT idempotency_key, status, gmail_message_id FROM gmail_sent_log WHERE idempotency_key = ?',
    ),
    completeSend: db.prepare(
      "UPDATE gmail_sent_log SET status = 'sent', gmail_message_id = ?, updated_at = ? WHERE idempotency_key = ?",
    ),
    sendSetting: db.prepare('SELECT send_enabled FROM gmail_settings WHERE user_id = ?'),
    setSendSetting: db.prepare(
      `INSERT INTO gmail_settings (user_id, send_enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET send_enabled = excluded.send_enabled, updated_at = excluded.updated_at`,
    ),
  };

  const store = {
    /** Every connected account for this owner, oldest first by address. */
    accounts(userId: string): GmailAccount[] {
      const rows = statements.accounts.all(userId) as GmailAccountRow[];
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        scopes: row.scopes,
        tokenSecret: row.token_secret,
      }));
    },

    /** One account, and only if it belongs to this owner. */
    account(id: string, userId: string): GmailAccount | undefined {
      const row = statements.account.get(id, userId) as GmailAccountRow | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        scopes: row.scopes,
        tokenSecret: row.token_secret,
      };
    },

    /**
     * Record the account Google's callback identified, or extend the scopes of
     * an existing one. The caller stores the refresh token in the secret
     * vault first and passes the secret's name here.
     */
    upsertAccount(
      userId: string,
      email: string,
      fields: { displayName?: string | null; scopes: string; tokenSecret: string },
    ): GmailAccount {
      const normalized = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
        throw new GmailStoreError('That is not an email address.');
      const existing = statements.accountByEmail.get(userId, normalized) as
        GmailAccountRow | undefined;
      const stamp = now();
      if (existing) {
        statements.updateAccount.run(
          fields.displayName ?? existing.display_name,
          fields.scopes,
          fields.tokenSecret,
          stamp,
          existing.id,
          userId,
        );
        return store.account(existing.id, userId)!;
      }
      const id = newId();
      statements.insertAccount.run(
        id,
        userId,
        normalized,
        fields.displayName ?? null,
        fields.scopes,
        fields.tokenSecret,
        stamp,
        stamp,
      );
      return store.account(id, userId)!;
    },

    /** Disconnect an account: the row, its drafts, approvals and sent log go.
     * The caller also removes the OAuth secret from the vault. */
    removeAccount(id: string, userId: string): void {
      statements.deleteAccount.run(id, userId);
    },

    /** Remember an OAuth CSRF state for ten minutes. */
    saveOAuthState(state: string, userId: string, kind: string, accountId?: string): void {
      statements.insertState.run(state, userId, kind, accountId ?? null, now());
    },

    /** Consume a state: returns it once, then it is gone. */
    takeOAuthState(
      state: string,
    ): { userId: string; kind: string; accountId: string | null; createdAt: string } | undefined {
      const row = statements.oauthState.get(state) as
        | {
            state: string;
            user_id: string;
            kind: string;
            account_id: string | null;
            created_at: string;
          }
        | undefined;
      if (!row) return undefined;
      statements.deleteState.run(state);
      return {
        userId: row.user_id,
        kind: row.kind,
        accountId: row.account_id,
        createdAt: row.created_at,
      };
    },

    /** Drop states older than the given ISO timestamp. */
    pruneOAuthStates(beforeIso: string): void {
      statements.pruneStates.run(beforeIso);
    },

    /** Create a local draft. Never touches the Gmail API. */
    createDraft(
      userId: string,
      accountId: string,
      draft: { to: string[]; cc?: string[]; subject?: string; body?: string; inReplyTo?: string },
    ): GmailDraft {
      const account = store.account(accountId, userId);
      if (!account) throw new GmailStoreError('Choose one of your connected Gmail accounts.', 404);
      for (const addr of [...draft.to, ...(draft.cc ?? [])])
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr))
          throw new GmailStoreError(`"${addr}" is not an email address.`);
      if (draft.to.length === 0) throw new GmailStoreError('A draft needs at least one recipient.');
      const id = newId();
      const stamp = now();
      statements.insertDraft.run(
        id,
        userId,
        accountId,
        JSON.stringify(draft.to),
        JSON.stringify(draft.cc ?? []),
        draft.subject ?? '',
        draft.body ?? '',
        draft.inReplyTo ?? null,
        stamp,
        stamp,
      );
      return store.draft(id, userId)!;
    },

    draft(id: string, userId: string): GmailDraft | undefined {
      const row = statements.draft.get(id, userId) as GmailDraftRow | undefined;
      return row ? toDraft(row) : undefined;
    },

    drafts(userId: string, accountId: string): GmailDraft[] {
      const rows = statements.drafts.all(userId, accountId) as GmailDraftRow[];
      return rows.map(toDraft);
    },

    updateDraft(
      id: string,
      userId: string,
      changes: { to?: string[]; cc?: string[]; subject?: string; body?: string },
    ): GmailDraft {
      const existing = store.draft(id, userId);
      if (!existing) throw new GmailStoreError('That draft is not saved here.', 404);
      const to = changes.to ?? existing.to;
      const cc = changes.cc ?? existing.cc;
      for (const addr of [...to, ...cc])
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr))
          throw new GmailStoreError(`"${addr}" is not an email address.`);
      if (to.length === 0) throw new GmailStoreError('A draft needs at least one recipient.');
      statements.updateDraft.run(
        JSON.stringify(to),
        JSON.stringify(cc),
        changes.subject ?? existing.subject,
        changes.body ?? existing.body,
        now(),
        id,
        userId,
      );
      return store.draft(id, userId)!;
    },

    deleteDraft(id: string, userId: string): void {
      statements.deleteDraft.run(id, userId);
    },

    /**
     * Issue a single-use send approval bound to the draft's exact content.
     * Returns the token; only its hash is stored. Editing the draft afterwards
     * changes the content hash and the approval stops matching.
     */
    approveDraft(
      draftId: string,
      userId: string,
      options: { now?: () => string; newToken?: () => string; ttlMs?: number } = {},
    ): { token: string; expiresAt: string } {
      const draft = store.draft(draftId, userId);
      if (!draft) throw new GmailStoreError('That draft is not saved here.', 404);
      const clock = options.now ?? now;
      const token = (
        options.newToken ??
        (() => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''))
      )();
      const expiresAt = new Date(
        Date.parse(clock()) + (options.ttlMs ?? 10 * 60_000),
      ).toISOString();
      statements.insertApproval.run(
        approvalTokenHash(token),
        userId,
        draft.accountId,
        draft.id,
        draftContentHash(draft),
        clock(),
        expiresAt,
      );
      return { token, expiresAt };
    },

    /** The stored approval behind a token, if any. */
    approval(token: string):
      | {
          userId: string;
          accountId: string;
          draftId: string;
          contentHash: string;
          expiresAt: string;
          usedAt: string | null;
        }
      | undefined {
      const row = statements.approval.get(approvalTokenHash(token)) as
        | {
            user_id: string;
            account_id: string;
            draft_id: string;
            content_hash: string;
            expires_at: string;
            used_at: string | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        userId: row.user_id,
        accountId: row.account_id,
        draftId: row.draft_id,
        contentHash: row.content_hash,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
    },

    /** Mark an approval used. Returns false when it was already used. */
    useApproval(token: string): boolean {
      const result = statements.useApproval.run(now(), approvalTokenHash(token)) as {
        changes: number;
      };
      return result.changes === 1;
    },

    /**
     * Claim an idempotency key. Returns the existing entry when the key was
     * seen before (retry), or null when this call claimed it first. The claim
     * lands before the Gmail API is called, so a crash mid-send still cannot
     * double-send: the retry finds the `sending` row and waits for (or
     * re-checks) the outcome rather than sending again.
     */
    claimSend(
      idempotencyKey: string,
      userId: string,
      accountId: string,
      draftId: string,
    ): { status: string; gmailMessageId: string | null } | null {
      if (!idempotencyKey || idempotencyKey.length > 128)
        throw new GmailStoreError('Send with an idempotency key (up to 128 characters).');
      const stamp = now();
      const result = statements.claimSend.run(
        idempotencyKey,
        userId,
        accountId,
        draftId,
        stamp,
        stamp,
      ) as { changes: number };
      if (result.changes === 0) {
        const row = statements.sentEntry.get(idempotencyKey) as
          { status: string; gmail_message_id: string | null } | undefined;
        return row ? { status: row.status, gmailMessageId: row.gmail_message_id } : null;
      }
      return null;
    },

    /** Record the Gmail message id of a claimed send. */
    completeSend(idempotencyKey: string, gmailMessageId: string): void {
      statements.completeSend.run(gmailMessageId, now(), idempotencyKey);
    },

    /** Whether this owner has explicitly switched sending on. Off by default. */
    sendEnabled(userId: string): boolean {
      const row = statements.sendSetting.get(userId) as { send_enabled: number } | undefined;
      return row?.send_enabled === 1;
    },

    setSendEnabled(userId: string, enabled: boolean): void {
      statements.setSendSetting.run(userId, enabled ? 1 : 0, now());
    },
  };

  return store;
}

export type GmailStore = ReturnType<typeof createGmailStore>;
