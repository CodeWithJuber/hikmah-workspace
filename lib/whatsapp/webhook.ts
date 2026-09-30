/** Signed webhook ingestion: verify -> dedupe -> store -> apply -> receipt.
 *
 * Meta retries a webhook delivery until we answer 200, so every event is
 * keyed before anything is applied: the same payload arriving twice applies
 * zero more times. Raw payloads are stored first (the audit trail), then
 * inbound messages are recorded and delivery/read statuses are mapped onto
 * our message rows. A status for a wamid we never sent stays "unknown" —
 * the receipt says so instead of inventing a mapping.
 */
import { verifyWebhookSignature, WhatsAppSignatureError } from './signature.ts';
import { classifyKeyword, nextOptInState } from './optin.ts';
import { normalizePhone } from './identity.ts';
import { WhatsAppStoreError, type WhatsAppStore } from './store.ts';

export class WhatsAppWebhookError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WhatsAppWebhookError';
    this.status = status;
  }
}

export type WebhookContext = {
  store: WhatsAppStore;
  userId: string;
  accountId: string;
  appSecret: string | null;
};

export type WebhookReceipt = {
  accepted: boolean;
  received: number;
  applied: number;
  deduped: number;
  inbound: number;
  statusUpdates: number;
  unknownWamids: string[];
  optOuts: number;
  optIns: number;
};

type MetaMessage = {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
};

type MetaStatus = {
  id: string;
  status: string;
  timestamp: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string }[];
};

/** Map Meta's status vocabulary onto ours; anything else stays unknown. */
export function mapMetaStatus(status: string): string {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function inboundText(message: MetaMessage): string | null {
  if (message.text?.body) return message.text.body;
  const caption = message.image?.caption ?? message.video?.caption ?? message.document?.caption;
  return caption ?? null;
}

export async function ingestWebhook(
  context: WebhookContext,
  input: { rawBody: string; signatureHeader: string | null },
): Promise<WebhookReceipt> {
  const { store, userId, accountId } = context;

  const account = store.account(accountId, userId);
  if (!account) throw new WhatsAppStoreError('No such WhatsApp account.', 404);
  if (!verifyWebhookSignature(input.rawBody, input.signatureHeader, context.appSecret)) {
    throw new WhatsAppSignatureError('Webhook signature did not verify.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new WhatsAppWebhookError('The webhook body is not valid JSON.', 400);
  }

  const receipt: WebhookReceipt = {
    accepted: true,
    received: 0,
    applied: 0,
    deduped: 0,
    inbound: 0,
    statusUpdates: 0,
    unknownWamids: [],
    optOuts: 0,
    optIns: 0,
  };

  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: { value?: unknown }[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change?.value ?? {}) as {
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
      };
      for (const message of value.messages ?? []) {
        receipt.received += 1;
        const dedupeKey = `msg:${message.id}`;
        const stored = store.recordWebhookEvent({
          dedupeKey,
          userId,
          accountId,
          eventType: 'message',
          payload: JSON.stringify(message),
        });
        if (stored.deduped) {
          receipt.deduped += 1;
          continue;
        }
        let phone: string;
        try {
          phone = normalizePhone(message.from);
        } catch {
          store.markEventApplied(dedupeKey);
          receipt.applied += 1;
          continue;
        }
        const text = inboundText(message);
        store.recordMessage(userId, {
          accountId,
          direction: 'inbound',
          wamid: message.id,
          phone,
          type: message.type ?? 'text',
          kind: 'session',
          status: 'received',
          bodyPreview: text ?? `[${message.type ?? 'message'}]`,
        });
        receipt.inbound += 1;
        // Consent keywords are read on every inbound text; STOP always wins.
        const verdict = classifyKeyword(text);
        if (verdict) {
          const current = store.optInFor(userId, phone)?.state ?? null;
          const next = nextOptInState(current === 'unknown' ? null : current, verdict);
          if (next) {
            store.setOptIn(userId, phone, next, 'webhook');
            if (verdict === 'opt_out') receipt.optOuts += 1;
            else receipt.optIns += 1;
          }
        }
        store.markEventApplied(dedupeKey);
        receipt.applied += 1;
      }
      for (const update of value.statuses ?? []) {
        receipt.received += 1;
        const dedupeKey = `status:${update.id}:${update.status}:${update.timestamp}`;
        const stored = store.recordWebhookEvent({
          dedupeKey,
          userId,
          accountId,
          eventType: 'status',
          payload: JSON.stringify(update),
        });
        if (stored.deduped) {
          receipt.deduped += 1;
          continue;
        }
        const mapped = mapMetaStatus(update.status);
        const errorText = update.errors?.[0]
          ? `${update.errors[0].code ?? ''} ${update.errors[0].title ?? ''}`.trim()
          : undefined;
        const updated = store.updateMessageStatus(update.id, userId, mapped, errorText);
        if (updated) receipt.statusUpdates += 1;
        else receipt.unknownWamids.push(update.id);
        store.markEventApplied(dedupeKey);
        receipt.applied += 1;
      }
    }
  }
  return receipt;
}
