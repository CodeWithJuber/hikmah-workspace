/** Outbound WhatsApp send pipeline.
 *
 * Consent-first and dry-run by default. The order of the gates is deliberate
 * and every refusal names the reason honestly:
 *
 *   1. account exists and belongs to the owner
 *   2. recipient number is usable and has opted in (unknown is not consent)
 *   3. 24h session-window rule: outside the window only approved templates
 *   4. a dry run stops here: payload built, receipt written, Meta untouched
 *   5. live sends need the owner switch AND no WHATSAPP_SEND_FORCE_OFF=1
 *   6. live sends need a single-use approval bound to the exact content
 *   7. the idempotency log claims the key before Meta is called
 *
 * No credentials exist in this deployment, so the live path is implemented
 * but reported as needing the owner's Meta activation — the fetch layer is
 * injected and mocked in tests, and the real Meta API is never called.
 */
import { estimateCost } from './cost.ts';
import { normalizePhone } from './identity.ts';
import { maySendTo } from './optin.ts';
import { withinSessionWindow, gateMessageKind } from './templates.ts';
import { sendContentHash, WhatsAppStoreError, type WhatsAppStore } from './store.ts';

export class WhatsAppClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'WhatsAppClientError';
    this.status = status;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SendContext = {
  store: WhatsAppStore;
  userId: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  accessToken: () => Promise<string | null>;
  nowMs?: () => number;
  newId?: () => string;
};

export type SendInput = {
  accountId: string;
  to: string;
  type?: string;
  templateName?: string | null;
  templateLanguage?: string;
  templateParams?: string[];
  body?: string | null;
  /** Dry-run is the default: plan and receipt, no network call. */
  dryRun?: boolean;
  approvalToken?: string | null;
  idempotencyKey?: string | null;
};

export type SendReceipt = {
  dryRun: boolean;
  metaCalled: boolean;
  replayed: boolean;
  messageId: string;
  wamid: string | null;
  to: string;
  kind: 'session' | 'template';
  type: string;
  costEstimateUsd: number;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
};

const GRAPH_VERSION = 'v21.0';

function messageUrl(phoneNumberId: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

/** The canonical content an approval must cover. */
export function sendInputHash(input: {
  to: string;
  kind: 'session' | 'template';
  type: string;
  templateName: string | null;
  templateParams: string[];
  body: string | null;
}): string {
  return sendContentHash({
    to: input.to,
    kind: input.kind,
    type: input.type,
    templateName: input.templateName,
    templateParams: input.templateParams,
    body: input.body,
  });
}

export async function planSend(context: SendContext, input: SendInput): Promise<SendReceipt> {
  const { store, userId } = context;
  const nowMs = context.nowMs ?? (() => Date.now());
  const newId = context.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));

  const account = store.account(input.accountId, userId);
  if (!account) throw new WhatsAppStoreError('No such WhatsApp account.', 404);

  // Gate 2: consent. normalizePhone throws on garbage; unknown is not consent.
  const phone = normalizePhone(input.to);
  const consent = store.optInFor(userId, phone);
  if (!maySendTo(consent?.state ?? null)) {
    throw new WhatsAppStoreError(
      consent?.state === 'opted_out'
        ? `${phone} opted out — sending is refused until they opt back in.`
        : `No opt-in recorded for ${phone} — consent is required before any send.`,
      403,
    );
  }

  // Gate 3: the 24h session window.
  const templates = store.templates(userId);
  const windowOpen = withinSessionWindow(store.lastInboundAt(userId, phone), nowMs());
  const { kind, template } = gateMessageKind({
    windowOpen,
    templateName: input.templateName ?? null,
    templates,
    templateLanguage: input.templateLanguage,
    templateParams: input.templateParams ?? [],
  });

  const type = kind === 'template' ? 'text' : (input.type ?? 'text');
  const templateParams = input.templateParams ?? [];
  const templateName = template?.name ?? null;
  const body = kind === 'template' ? null : (input.body ?? null);
  if (kind === 'session' && (!body || !body.trim())) {
    throw new WhatsAppStoreError('A session message needs a text body.', 400);
  }

  const contentHash = sendInputHash({
    to: phone,
    kind,
    type,
    templateName,
    templateParams,
    body,
  });

  // The payload Meta would receive — built identically for dry-run and live.
  const payload: Record<string, unknown> =
    kind === 'template'
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'template',
          template: {
            name: template!.name,
            language: { code: template!.language },
            ...(templateParams.length
              ? {
                  components: [
                    {
                      type: 'body',
                      parameters: templateParams.map((text) => ({ type: 'text', text })),
                    },
                  ],
                }
              : {}),
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body },
        };

  const costEstimateUsd = estimateCost({ kind, type });

  // Gate 4: dry-run stops here — receipt written, Meta never called.
  const dryRun = input.dryRun !== false;
  if (dryRun) {
    const row = store.recordMessage(userId, {
      accountId: account.id,
      direction: 'outbound',
      phone,
      type,
      kind,
      templateName,
      status: 'dry_run',
      bodyPreview: kind === 'template' ? `[template ${templateName}]` : (body ?? ''),
      costEstimate: costEstimateUsd,
    });
    return {
      dryRun: true,
      metaCalled: false,
      replayed: false,
      messageId: row.id,
      wamid: null,
      to: phone,
      kind,
      type,
      costEstimateUsd,
      payload,
      idempotencyKey: null,
    };
  }

  // Gate 5: the switch and the deployment kill-switch.
  if (context.env?.WHATSAPP_SEND_FORCE_OFF === '1') {
    throw new WhatsAppStoreError(
      'Sending is force-disabled for this deployment (WHATSAPP_SEND_FORCE_OFF=1).',
      403,
    );
  }
  if (!store.sendEnabled(userId)) {
    throw new WhatsAppStoreError(
      'WhatsApp sending is off — the owner must switch it on in Integrations first.',
      403,
    );
  }

  // Gate 6: single-use approval bound to this exact content.
  if (!input.approvalToken) {
    throw new WhatsAppStoreError('A live send needs an approval token — approve first.', 403);
  }
  const approvedAccountId = store.consumeApproval(userId, input.approvalToken, contentHash);
  if (approvedAccountId !== account.id) {
    throw new WhatsAppStoreError('That approval was issued for a different account.', 403);
  }

  // Gate 7: idempotency — claim before Meta is called.
  const idempotencyKey = input.idempotencyKey ?? newId();
  const row = store.recordMessage(userId, {
    accountId: account.id,
    direction: 'outbound',
    phone,
    type,
    kind,
    templateName,
    status: 'queued',
    bodyPreview: kind === 'template' ? `[template ${templateName}]` : (body ?? ''),
    costEstimate: costEstimateUsd,
    idempotencyKey,
  });
  const claim = store.claimSend(idempotencyKey, userId, account.id, row.id);
  if (!claim.claimed) {
    const earlier = store.message(claim.messageId, userId);
    return {
      dryRun: false,
      metaCalled: false,
      replayed: true,
      messageId: claim.messageId,
      wamid: earlier?.wamid ?? null,
      to: phone,
      kind,
      type,
      costEstimateUsd,
      payload,
      idempotencyKey,
    };
  }

  const token = await context.accessToken();
  if (!token) {
    store.completeSend(idempotencyKey, 'failed');
    throw new WhatsAppClientError(
      'No Meta access token is configured — connect the WhatsApp Business account first.',
      503,
    );
  }

  let response: Response;
  try {
    response = await context.fetchImpl(messageUrl(account.phoneNumberId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    store.completeSend(idempotencyKey, 'failed');
    throw new WhatsAppClientError(
      `Meta call failed before a response: ${(error as Error).message}`,
      502,
    );
  }
  const data = (await response.json().catch(() => null)) as {
    messages?: { id: string }[];
    error?: { message?: string };
  } | null;
  if (!response.ok || !data?.messages?.[0]?.id) {
    store.completeSend(idempotencyKey, 'failed');
    const detail = data?.error?.message ?? `HTTP ${response.status}`;
    throw new WhatsAppClientError(`Meta refused the message: ${detail}`, 502);
  }

  const wamid = data.messages[0].id;
  store.setMessageWamid(row.id, userId, wamid, 'sent');
  store.completeSend(idempotencyKey, 'sent', wamid);
  return {
    dryRun: false,
    metaCalled: true,
    replayed: false,
    messageId: row.id,
    wamid,
    to: phone,
    kind,
    type,
    costEstimateUsd,
    payload,
    idempotencyKey,
  };
}
