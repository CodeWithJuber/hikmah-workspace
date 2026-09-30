/** WhatsApp channel store: accounts, consent, templates, identity links,
 * messages, webhook events, send approvals, the sent log and the switch.
 *
 * Built on the raw `node:sqlite` handle like `lib/gmail/store.ts`, for the
 * same reason: this module imports nothing from Next so it can be tested
 * with a bare in-memory database. The Meta access token never touches these
 * tables — it lives in the encrypted workspace_secrets vault, and the
 * account row only records the secret's name.
 */
import { createHash } from 'node:crypto';
import type { SqliteHandle } from '../runs/store.ts';
import { normalizePhone } from './identity.ts';

export class WhatsAppStoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WhatsAppStoreError';
    this.status = status;
  }
}

export type WhatsAppAccount = {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  businessAccountId: string | null;
  tokenSecret: string;
};

export type OptInRow = {
  phone: string;
  state: 'opted_in' | 'opted_out' | 'unknown';
  source: string;
  updatedAt: string;
};

export type TemplateRow = {
  name: string;
  language: string;
  category: string;
  body: string;
  variableCount: number;
  status: 'approved' | 'pending' | 'rejected';
};

export type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  wamid: string | null;
  phone: string;
  type: string;
  kind: 'session' | 'template';
  templateName: string | null;
  status: string;
  bodyPreview: string;
  costEstimate: number;
  idempotencyKey: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookIngestResult = {
  /** Already stored — the event is applied zero more times. */
  deduped: boolean;
};

const OPTIN_SOURCES = new Set(['api', 'webhook', 'import']);

export function createWhatsAppStore(
  db: SqliteHandle,
  options: { now?: () => string; newId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));

  const mustAccount = (accountId: string, userId: string) => {
    const row = db
      .prepare(
        'SELECT id, phone_number_id, display_phone_number, business_account_id, token_secret FROM whatsapp_accounts WHERE id = ? AND user_id = ?',
      )
      .get(accountId, userId) as WhatsAppAccount | undefined;
    if (!row) throw new WhatsAppStoreError('No such WhatsApp account.', 404);
    return row;
  };

  return {
    // -- accounts -----------------------------------------------------------
    upsertAccount(
      userId: string,
      fields: {
        phoneNumberId: string;
        displayPhoneNumber?: string | null;
        businessAccountId?: string | null;
        tokenSecret: string;
      },
    ): WhatsAppAccount {
      const at = now();
      const existing = db
        .prepare('SELECT id FROM whatsapp_accounts WHERE user_id = ? AND phone_number_id = ?')
        .get(userId, fields.phoneNumberId) as { id: string } | undefined;
      if (existing) {
        db.prepare(
          'UPDATE whatsapp_accounts SET display_phone_number = ?, business_account_id = ?, token_secret = ?, updated_at = ? WHERE id = ?',
        ).run(
          fields.displayPhoneNumber ?? null,
          fields.businessAccountId ?? null,
          fields.tokenSecret,
          at,
          existing.id,
        );
        return this.account(existing.id, userId)!;
      }
      const id = newId();
      db.prepare(
        'INSERT INTO whatsapp_accounts (id, user_id, phone_number_id, display_phone_number, business_account_id, token_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        userId,
        fields.phoneNumberId,
        fields.displayPhoneNumber ?? null,
        fields.businessAccountId ?? null,
        fields.tokenSecret,
        at,
        at,
      );
      return this.account(id, userId)!;
    },

    account(accountId: string, userId: string): WhatsAppAccount | undefined {
      const row = db
        .prepare(
          'SELECT id, phone_number_id, display_phone_number, business_account_id, token_secret FROM whatsapp_accounts WHERE id = ? AND user_id = ?',
        )
        .get(accountId, userId) as
        | {
            id: string;
            phone_number_id: string;
            display_phone_number: string | null;
            business_account_id: string | null;
            token_secret: string;
          }
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        phoneNumberId: row.phone_number_id,
        displayPhoneNumber: row.display_phone_number,
        businessAccountId: row.business_account_id,
        tokenSecret: row.token_secret,
      };
    },

    accounts(userId: string): WhatsAppAccount[] {
      const rows = db
        .prepare('SELECT id FROM whatsapp_accounts WHERE user_id = ? ORDER BY created_at')
        .all(userId) as { id: string }[];
      return rows.map((row) => this.account(row.id, userId)!);
    },

    /** Route a webhook to its owner: Meta sends the phone_number_id in the
     * payload metadata, and each number belongs to exactly one account. */
    accountByPhoneNumberId(
      phoneNumberId: string,
    ): { userId: string; account: WhatsAppAccount } | undefined {
      const row = db
        .prepare('SELECT id, user_id FROM whatsapp_accounts WHERE phone_number_id = ?')
        .get(phoneNumberId) as { id: string; user_id: string } | undefined;
      if (!row) return undefined;
      const account = this.account(row.id, row.user_id);
      return account ? { userId: row.user_id, account } : undefined;
    },

    removeAccount(accountId: string, userId: string): void {
      mustAccount(accountId, userId);
      db.prepare('DELETE FROM whatsapp_accounts WHERE id = ? AND user_id = ?').run(
        accountId,
        userId,
      );
    },

    // -- consent ------------------------------------------------------------
    setOptIn(
      userId: string,
      phone: string,
      state: 'opted_in' | 'opted_out',
      source: string,
    ): OptInRow {
      const normalized = normalizePhone(phone);
      if (!OPTIN_SOURCES.has(source)) {
        throw new WhatsAppStoreError(`Unknown opt-in source "${source}".`, 400);
      }
      const at = now();
      db.prepare(
        `INSERT INTO whatsapp_optins (user_id, phone, state, source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, phone) DO UPDATE SET state = excluded.state, source = excluded.source, updated_at = excluded.updated_at`,
      ).run(userId, normalized, state, source, at);
      return this.optInFor(userId, normalized)!;
    },

    optInFor(userId: string, phone: string): OptInRow | undefined {
      const normalized = normalizePhone(phone);
      const row = db
        .prepare(
          'SELECT phone, state, source, updated_at FROM whatsapp_optins WHERE user_id = ? AND phone = ?',
        )
        .get(userId, normalized) as
        { phone: string; state: OptInRow['state']; source: string; updated_at: string } | undefined;
      if (!row) return undefined;
      return { phone: row.phone, state: row.state, source: row.source, updatedAt: row.updated_at };
    },

    // -- templates ----------------------------------------------------------
    upsertTemplate(
      userId: string,
      fields: {
        name: string;
        language?: string;
        category?: string;
        body?: string;
        variableCount?: number;
        status?: TemplateRow['status'];
        accountId?: string | null;
      },
    ): TemplateRow {
      const name = fields.name.trim();
      if (!name) throw new WhatsAppStoreError('Template needs a name.', 400);
      const language = fields.language ?? 'en_US';
      if (fields.status && !['approved', 'pending', 'rejected'].includes(fields.status)) {
        throw new WhatsAppStoreError(`Unknown template status "${fields.status}".`, 400);
      }
      if (fields.accountId) mustAccount(fields.accountId, userId);
      const at = now();
      db.prepare(
        `INSERT INTO whatsapp_templates (name, user_id, account_id, language, category, body, variable_count, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name, language, user_id) DO UPDATE SET
           account_id = excluded.account_id, category = excluded.category, body = excluded.body,
           variable_count = excluded.variable_count, status = excluded.status, updated_at = excluded.updated_at`,
      ).run(
        name,
        userId,
        fields.accountId ?? null,
        language,
        fields.category ?? 'utility',
        fields.body ?? '',
        fields.variableCount ?? 0,
        fields.status ?? 'pending',
        at,
      );
      return this.template(userId, name, language)!;
    },

    template(userId: string, name: string, language: string): TemplateRow | undefined {
      const row = db
        .prepare(
          'SELECT name, language, category, body, variable_count, status FROM whatsapp_templates WHERE user_id = ? AND name = ? AND language = ?',
        )
        .get(userId, name, language) as
        | {
            name: string;
            language: string;
            category: string;
            body: string;
            variable_count: number;
            status: TemplateRow['status'];
          }
        | undefined;
      if (!row) return undefined;
      return {
        name: row.name,
        language: row.language,
        category: row.category,
        body: row.body,
        variableCount: row.variable_count,
        status: row.status,
      };
    },

    templates(userId: string): TemplateRow[] {
      const rows = db
        .prepare(
          'SELECT user_id, name, language FROM whatsapp_templates WHERE user_id = ? ORDER BY name, language',
        )
        .all(userId) as { user_id: string; name: string; language: string }[];
      return rows.map((row) => this.template(row.user_id, row.name, row.language)!);
    },

    approvedTemplates(userId: string): TemplateRow[] {
      return this.templates(userId).filter((t) => t.status === 'approved');
    },

    // -- identity links -----------------------------------------------------
    requestLinkCode(userId: string, phone: string, codeHash: string, expiresAt: string): void {
      const normalized = normalizePhone(phone);
      db.prepare(
        `INSERT INTO whatsapp_identity_links (user_id, phone, code_hash, code_expires_at, linked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (user_id, phone) DO UPDATE SET
           code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at,
           linked_at = CASE WHEN whatsapp_identity_links.linked_at IS NULL THEN NULL ELSE whatsapp_identity_links.linked_at END`,
      ).run(userId, normalized, codeHash, expiresAt);
    },

    /** The pending code a confirm step checks against — the store owns the SQL. */
    pendingLinkCode(
      userId: string,
      phone: string,
    ): { codeHash: string | null; expiresAt: string | null } | undefined {
      const normalized = normalizePhone(phone);
      return db
        .prepare(
          'SELECT code_hash AS codeHash, code_expires_at AS expiresAt FROM whatsapp_identity_links WHERE user_id = ? AND phone = ?',
        )
        .get(userId, normalized) as
        { codeHash: string | null; expiresAt: string | null } | undefined;
    },

    confirmLink(userId: string, phone: string, codeHash: string, nowMs: number): void {
      const normalized = normalizePhone(phone);
      const row = db
        .prepare(
          'SELECT code_hash, code_expires_at FROM whatsapp_identity_links WHERE user_id = ? AND phone = ?',
        )
        .get(userId, normalized) as
        { code_hash: string | null; code_expires_at: string | null } | undefined;
      if (!row || !row.code_hash || row.code_hash !== codeHash) {
        throw new WhatsAppStoreError('That code does not match — request a fresh one.', 403);
      }
      if (!row.code_expires_at || Date.parse(row.code_expires_at) <= nowMs) {
        throw new WhatsAppStoreError('That code expired — request a fresh one.', 403);
      }
      db.prepare(
        'UPDATE whatsapp_identity_links SET linked_at = ?, code_hash = NULL, code_expires_at = NULL WHERE user_id = ? AND phone = ?',
      ).run(now(), userId, normalized);
    },

    unlinkPhone(userId: string, phone: string): void {
      const normalized = normalizePhone(phone);
      db.prepare('DELETE FROM whatsapp_identity_links WHERE user_id = ? AND phone = ?').run(
        userId,
        normalized,
      );
    },

    linkedUserFor(userId: string, phone: string): string | null {
      const normalized = normalizePhone(phone);
      const row = db
        .prepare('SELECT linked_at FROM whatsapp_identity_links WHERE user_id = ? AND phone = ?')
        .get(userId, normalized) as { linked_at: string | null } | undefined;
      return row?.linked_at ? userId : null;
    },

    // -- messages -----------------------------------------------------------
    recordMessage(
      userId: string,
      fields: {
        accountId?: string | null;
        direction: 'inbound' | 'outbound';
        wamid?: string | null;
        phone: string;
        type?: string;
        kind?: 'session' | 'template';
        templateName?: string | null;
        status?: string;
        bodyPreview?: string;
        costEstimate?: number;
        idempotencyKey?: string | null;
        error?: string | null;
      },
    ): MessageRow {
      const id = newId();
      const at = now();
      db.prepare(
        `INSERT INTO whatsapp_messages
           (id, user_id, account_id, direction, wamid, phone, type, kind, template_name, status, body_preview, cost_estimate, idempotency_key, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        fields.accountId ?? null,
        fields.direction,
        fields.wamid ?? null,
        normalizePhone(fields.phone),
        fields.type ?? 'text',
        fields.kind ?? 'session',
        fields.templateName ?? null,
        fields.status ?? 'unknown',
        (fields.bodyPreview ?? '').slice(0, 200),
        fields.costEstimate ?? 0,
        fields.idempotencyKey ?? null,
        fields.error ?? null,
        at,
        at,
      );
      return this.message(id, userId)!;
    },

    message(id: string, userId: string): MessageRow | undefined {
      const row = db
        .prepare('SELECT * FROM whatsapp_messages WHERE id = ? AND user_id = ?')
        .get(id, userId) as Record<string, string | number | null> | undefined;
      return row ? toMessageRow(row) : undefined;
    },

    messageByWamid(wamid: string, userId: string): MessageRow | undefined {
      const row = db
        .prepare('SELECT * FROM whatsapp_messages WHERE wamid = ? AND user_id = ?')
        .get(wamid, userId) as Record<string, string | number | null> | undefined;
      return row ? toMessageRow(row) : undefined;
    },

    updateMessageStatus(wamid: string, userId: string, status: string, error?: string): boolean {
      const at = now();
      const result = db
        .prepare(
          'UPDATE whatsapp_messages SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE wamid = ? AND user_id = ?',
        )
        .run(status, error ?? null, at, wamid, userId) as { changes: number };
      return Number(result.changes) > 0;
    },

    /** Attach Meta's message id to an outbound row once Meta accepts it. */
    setMessageWamid(id: string, userId: string, wamid: string, status: string): void {
      db.prepare(
        'UPDATE whatsapp_messages SET wamid = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).run(wamid, status, now(), id, userId);
    },

    messagesFor(userId: string, phone?: string): MessageRow[] {
      const rows = phone
        ? (db
            .prepare(
              'SELECT * FROM whatsapp_messages WHERE user_id = ? AND phone = ? ORDER BY created_at DESC, id DESC LIMIT 200',
            )
            .all(userId, normalizePhone(phone)) as Record<string, string | number | null>[])
        : (db
            .prepare(
              'SELECT * FROM whatsapp_messages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
            )
            .all(userId) as Record<string, string | number | null>[]);
      return rows.map(toMessageRow);
    },

    lastInboundAt(userId: string, phone: string): string | null {
      const row = db
        .prepare(
          "SELECT created_at FROM whatsapp_messages WHERE user_id = ? AND phone = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1",
        )
        .get(userId, normalizePhone(phone)) as { created_at: string } | undefined;
      return row?.created_at ?? null;
    },

    // -- webhook events (dedupe) ---------------------------------------------
    recordWebhookEvent(args: {
      dedupeKey: string;
      userId: string;
      accountId?: string | null;
      eventType: string;
      payload: string;
    }): WebhookIngestResult {
      const at = now();
      try {
        db.prepare(
          'INSERT INTO whatsapp_webhook_events (dedupe_key, user_id, account_id, event_type, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          args.dedupeKey,
          args.userId,
          args.accountId ?? null,
          args.eventType,
          args.payload,
          at,
        );
      } catch {
        return { deduped: true };
      }
      return { deduped: false };
    },

    markEventApplied(dedupeKey: string): void {
      db.prepare('UPDATE whatsapp_webhook_events SET applied_at = ? WHERE dedupe_key = ?').run(
        now(),
        dedupeKey,
      );
    },

    // -- send approvals ------------------------------------------------------
    createSendApproval(
      userId: string,
      accountId: string,
      contentHash: string,
      ttlMs = 10 * 60 * 1000,
    ): { token: string; tokenHash: string; expiresAt: string } {
      mustAccount(accountId, userId);
      const token = newId() + newId();
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const at = now();
      const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
      db.prepare(
        'INSERT INTO whatsapp_send_approvals (token_hash, user_id, account_id, content_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(tokenHash, userId, accountId, contentHash, at, expiresAt);
      return { token, tokenHash, expiresAt };
    },

    consumeApproval(userId: string, token: string, contentHash: string): string {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const row = db
        .prepare(
          'SELECT account_id, content_hash, expires_at, used_at FROM whatsapp_send_approvals WHERE token_hash = ? AND user_id = ?',
        )
        .get(tokenHash, userId) as
        | { account_id: string; content_hash: string; expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || Date.parse(row.expires_at) <= Date.parse(now())) {
        throw new WhatsAppStoreError('That approval is missing, used or expired.', 403);
      }
      if (row.content_hash !== contentHash) {
        throw new WhatsAppStoreError('The message changed after approval — approve it again.', 403);
      }
      db.prepare('UPDATE whatsapp_send_approvals SET used_at = ? WHERE token_hash = ?').run(
        now(),
        tokenHash,
      );
      return row.account_id;
    },

    // -- sent log (idempotency) ------------------------------------------------
    claimSend(
      idempotencyKey: string,
      userId: string,
      accountId: string,
      messageId: string,
    ): { claimed: boolean; messageId: string } {
      const at = now();
      try {
        db.prepare(
          'INSERT INTO whatsapp_sent_log (idempotency_key, user_id, account_id, message_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(idempotencyKey, userId, accountId, messageId, 'sending', at, at);
        return { claimed: true, messageId };
      } catch {
        const row = db
          .prepare(
            'SELECT message_id, status, meta_message_id FROM whatsapp_sent_log WHERE idempotency_key = ? AND user_id = ?',
          )
          .get(idempotencyKey, userId) as { message_id: string; status: string } | undefined;
        if (!row) throw new WhatsAppStoreError('That send is already in flight elsewhere.', 409);
        return { claimed: false, messageId: row.message_id };
      }
    },

    completeSend(idempotencyKey: string, status: 'sent' | 'failed', metaMessageId?: string): void {
      db.prepare(
        'UPDATE whatsapp_sent_log SET status = ?, meta_message_id = ?, updated_at = ? WHERE idempotency_key = ?',
      ).run(status, metaMessageId ?? null, now(), idempotencyKey);
    },

    // -- the switch -----------------------------------------------------------
    sendEnabled(userId: string): boolean {
      const row = db
        .prepare('SELECT send_enabled FROM whatsapp_settings WHERE user_id = ?')
        .get(userId) as { send_enabled: number } | undefined;
      return (row?.send_enabled ?? 0) === 1;
    },

    setSendEnabled(userId: string, enabled: boolean): void {
      db.prepare(
        `INSERT INTO whatsapp_settings (user_id, send_enabled, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET send_enabled = excluded.send_enabled, updated_at = excluded.updated_at`,
      ).run(userId, enabled ? 1 : 0, now());
    },

    // -- spend -----------------------------------------------------------------
    outboundSpend(userId: string): number {
      const rows = db
        .prepare(
          "SELECT cost_estimate FROM whatsapp_messages WHERE user_id = ? AND direction = 'outbound'",
        )
        .all(userId) as { cost_estimate: number }[];
      return rows.reduce((sum, row) => sum + (Number(row.cost_estimate) || 0), 0);
    },
  };
}

function toMessageRow(row: Record<string, string | number | null>): MessageRow {
  return {
    id: String(row.id),
    direction: row.direction as 'inbound' | 'outbound',
    wamid: (row.wamid as string | null) ?? null,
    phone: String(row.phone),
    type: String(row.type),
    kind: row.kind as 'session' | 'template',
    templateName: (row.template_name as string | null) ?? null,
    status: String(row.status),
    bodyPreview: String(row.body_preview ?? ''),
    costEstimate: Number(row.cost_estimate) || 0,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** The exact bytes an approval covers: recipient, kind, type, template, body. */
export function sendContentHash(input: {
  to: string;
  kind: 'session' | 'template';
  type: string;
  templateName: string | null;
  templateParams: string[];
  body: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        to: normalizePhone(input.to),
        kind: input.kind,
        type: input.type,
        templateName: input.templateName,
        templateParams: input.templateParams,
        body: input.body,
      }),
    )
    .digest('hex');
}

export type WhatsAppStore = ReturnType<typeof createWhatsAppStore>;
