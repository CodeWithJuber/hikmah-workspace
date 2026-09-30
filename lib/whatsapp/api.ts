/** Request handlers for the WhatsApp routes — pure of Next, so every rule
 * is testable against an in-memory database with injected secrets and fetch.
 *
 * The webhook (Meta calling us) is the one unauthenticated entry: it is
 * authenticated by the HMAC signature and routed to the owning account via
 * the phone_number_id in the payload metadata. Everything else needs the
 * owner's session, which the route layer checks before calling in.
 */
import type { SqliteHandle } from '../runs/store.ts';
import { createWhatsAppStore, WhatsAppStoreError, type WhatsAppAccount } from './store.ts';
import { verifyWebhookSignature, WhatsAppSignatureError } from './signature.ts';
import { maySendTo } from './optin.ts';
import { WhatsAppTemplateError } from './templates.ts';
import {
  normalizePhone,
  mintLinkCode,
  linkCodeHash,
  verifyLinkCode,
  LINK_CODE_TTL_MS,
  WhatsAppIdentityError,
} from './identity.ts';
import { totalSpend } from './cost.ts';
import { planSend, sendInputHash, WhatsAppClientError, type FetchLike } from './send.ts';
import { ingestWebhook, WhatsAppWebhookError } from './webhook.ts';

export type { FetchLike };

export type WhatsAppApiContext = {
  db: SqliteHandle;
  userId: string | null;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  getAccessToken: (account: WhatsAppAccount) => Promise<string | null>;
  now?: () => string;
  newId?: () => string;
};

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers });
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

function storeFor(context: WhatsAppApiContext) {
  return createWhatsAppStore(context.db, { now: context.now, newId: context.newId });
}

function requireUser(context: WhatsAppApiContext): string {
  if (!context.userId) throw new WhatsAppStoreError('Sign in to your private workspace.', 401);
  return context.userId;
}

function handleError(error: unknown): Response {
  if (error instanceof WhatsAppStoreError) return fail(error.message, error.status);
  if (error instanceof WhatsAppTemplateError) return fail(error.message, error.status);
  if (error instanceof WhatsAppIdentityError) return fail(error.message, error.status);
  if (error instanceof WhatsAppSignatureError) return fail(error.message, 401);
  if (error instanceof WhatsAppWebhookError) return fail(error.message, error.status);
  if (error instanceof WhatsAppClientError) return fail(error.message, error.status);
  throw error;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  return (await request.json().catch(() => null)) as Record<string, unknown> | null;
}

/**
 * GET /api/whatsapp/accounts — list. POST — connect {phoneNumberId,
 * displayPhoneNumber?, businessAccountId?, tokenSecret}. DELETE — {accountId}.
 */
export async function accountsRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    if (request.method === 'GET') return ok({ accounts: store.accounts(userId) });
    const body = await readBody(request);
    if (!body) return fail('Send a JSON body.', 400);
    if (request.method === 'POST') {
      if (typeof body.phoneNumberId !== 'string' || !body.phoneNumberId.trim()) {
        return fail('phoneNumberId is required.', 400);
      }
      if (typeof body.tokenSecret !== 'string' || !body.tokenSecret.trim()) {
        return fail('tokenSecret is required — the vault name holding the access token.', 400);
      }
      const account = store.upsertAccount(userId, {
        phoneNumberId: body.phoneNumberId.trim(),
        displayPhoneNumber:
          typeof body.displayPhoneNumber === 'string' ? body.displayPhoneNumber : null,
        businessAccountId:
          typeof body.businessAccountId === 'string' ? body.businessAccountId : null,
        tokenSecret: body.tokenSecret.trim(),
      });
      return ok({ account }, 201);
    }
    if (request.method === 'DELETE') {
      if (typeof body.accountId !== 'string') return fail('accountId is required.', 400);
      store.removeAccount(body.accountId, userId);
      return ok({ removed: true });
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/whatsapp/optin?phone= — read state (unknown when no row).
 * POST {phone, action: 'opt_in'|'opt_out', source?} — the owner's explicit act.
 */
export async function optinRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    if (request.method === 'GET') {
      const phone = new URL(request.url).searchParams.get('phone');
      if (!phone) return fail('phone is required.', 400);
      const row = store.optInFor(userId, phone);
      return ok({
        phone: normalizePhone(phone),
        state: row?.state ?? 'unknown',
        source: row?.source ?? null,
        maySend: maySendTo(row?.state ?? null),
      });
    }
    if (request.method === 'POST') {
      const body = await readBody(request);
      if (!body) return fail('Send a JSON body.', 400);
      if (typeof body.phone !== 'string') return fail('phone is required.', 400);
      if (body.action !== 'opt_in' && body.action !== 'opt_out') {
        return fail('action must be opt_in or opt_out.', 400);
      }
      const source = typeof body.source === 'string' ? body.source : 'api';
      const row = store.setOptIn(
        userId,
        body.phone,
        body.action === 'opt_in' ? 'opted_in' : 'opted_out',
        source,
      );
      return ok({ phone: row.phone, state: row.state, source: row.source });
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/whatsapp/identity — {action: 'request_code', phone} returns a
 * code the owner reads to the user out of band; {action: 'confirm', phone,
 * code} links the number; {action: 'unlink', phone} breaks the link.
 */
export async function identityRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    if (request.method !== 'POST') return fail('Method not allowed.', 405);
    const body = await readBody(request);
    if (!body || typeof body.phone !== 'string') return fail('phone is required.', 400);
    const phone = normalizePhone(body.phone);
    const nowMs = Date.parse((context.now ?? (() => new Date().toISOString()))());
    if (body.action === 'request_code') {
      const code = mintLinkCode();
      const expiresAt = new Date(nowMs + LINK_CODE_TTL_MS).toISOString();
      store.requestLinkCode(userId, phone, linkCodeHash(code), expiresAt);
      return ok({ phone, code, expiresAt });
    }
    if (body.action === 'confirm') {
      if (typeof body.code !== 'string') return fail('code is required.', 400);
      const pending = store.pendingLinkCode(userId, phone);
      if (
        !verifyLinkCode(body.code, pending?.codeHash ?? null, pending?.expiresAt ?? null, nowMs)
      ) {
        return fail('That code does not match or has expired — request a fresh one.', 403);
      }
      store.confirmLink(userId, phone, linkCodeHash(body.code), nowMs);
      return ok({ phone, linked: true });
    }
    if (body.action === 'unlink') {
      store.unlinkPhone(userId, phone);
      return ok({ phone, linked: false });
    }
    return fail('action must be request_code, confirm or unlink.', 400);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/whatsapp/templates — list. POST — upsert {name, language?,
 * category?, body?, variableCount?, status?, accountId?}.
 */
export async function templatesRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    if (request.method === 'GET') return ok({ templates: store.templates(userId) });
    if (request.method === 'POST') {
      const body = await readBody(request);
      if (!body || typeof body.name !== 'string') return fail('name is required.', 400);
      const template = store.upsertTemplate(userId, {
        name: body.name,
        language: typeof body.language === 'string' ? body.language : undefined,
        category: typeof body.category === 'string' ? body.category : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
        variableCount: typeof body.variableCount === 'number' ? body.variableCount : undefined,
        status:
          body.status === 'approved' || body.status === 'pending' || body.status === 'rejected'
            ? body.status
            : undefined,
        accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
      });
      return ok({ template }, 201);
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    return handleError(error);
  }
}

function parseSendFields(body: Record<string, unknown>) {
  return {
    accountId: body.accountId,
    to: body.to,
    type: typeof body.type === 'string' ? body.type : 'text',
    templateName: typeof body.templateName === 'string' ? body.templateName : null,
    templateLanguage: typeof body.templateLanguage === 'string' ? body.templateLanguage : undefined,
    templateParams: Array.isArray(body.templateParams) ? body.templateParams.map(String) : [],
    body: typeof body.body === 'string' ? body.body : null,
  };
}

/**
 * POST /api/whatsapp/send — {action: 'approve', ...message} returns a
 * single-use token bound to the exact content; {action: 'send',
 * approvalToken?, idempotencyKey?, dryRun?, ...message} plans (dry-run, the
 * default) or sends. A live send needs the owner switch on and no
 * WHATSAPP_SEND_FORCE_OFF=1.
 */
export async function sendRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    if (request.method !== 'POST') return fail('Method not allowed.', 405);
    const body = await readBody(request);
    if (!body) return fail('Send a JSON body.', 400);
    const store = storeFor(context);

    if (body.action === 'approve') {
      const fields = parseSendFields(body);
      if (typeof fields.accountId !== 'string' || typeof fields.to !== 'string') {
        return fail('accountId and to are required.', 400);
      }
      const phone = normalizePhone(fields.to);
      const windowOpenNote =
        'Approval binds content only — the 24h window and consent are checked at send time.';
      const hash = sendInputHash({
        to: phone,
        kind: fields.templateName ? 'template' : 'session',
        type: fields.type,
        templateName: fields.templateName,
        templateParams: fields.templateParams,
        body: fields.body,
      });
      const approval = store.createSendApproval(userId, fields.accountId, hash);
      return ok(
        { approvalToken: approval.token, expiresAt: approval.expiresAt, note: windowOpenNote },
        201,
      );
    }

    if (body.action === 'send') {
      const fields = parseSendFields(body);
      if (typeof fields.accountId !== 'string' || typeof fields.to !== 'string') {
        return fail('accountId and to are required.', 400);
      }
      const account = store.account(fields.accountId, userId);
      if (!account) return fail('No such WhatsApp account.', 404);
      const receipt = await planSend(
        {
          store,
          userId,
          env: context.env,
          fetchImpl: context.fetchImpl,
          accessToken: () => context.getAccessToken(account),
          nowMs: () => Date.parse((context.now ?? (() => new Date().toISOString()))()),
          newId: context.newId,
        },
        {
          accountId: fields.accountId,
          to: fields.to,
          type: fields.type,
          templateName: fields.templateName,
          templateLanguage: fields.templateLanguage,
          templateParams: fields.templateParams,
          body: fields.body,
          dryRun: body.dryRun !== false,
          approvalToken: typeof body.approvalToken === 'string' ? body.approvalToken : null,
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
        },
      );
      return ok({ receipt });
    }

    return fail('action must be approve or send.', 400);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/whatsapp/settings — the send switch. PATCH {sendEnabled}.
 * The deployment kill-switch WHATSAPP_SEND_FORCE_OFF=1 overrides it.
 */
export async function settingsRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    const forceOff = context.env?.WHATSAPP_SEND_FORCE_OFF === '1';
    if (request.method === 'GET') {
      return ok({
        sendEnabled: store.sendEnabled(userId) && !forceOff,
        forceOff,
        spendUsd: totalSpend(
          store
            .messagesFor(userId)
            .filter((m) => m.direction === 'outbound')
            .map((m) => ({ cost_estimate: m.costEstimate })),
        ),
      });
    }
    if (request.method === 'PATCH') {
      const body = await readBody(request);
      if (!body || typeof body.sendEnabled !== 'boolean') {
        return fail('Say whether sending should be on or off.', 400);
      }
      store.setSendEnabled(userId, body.sendEnabled);
      return ok({ sendEnabled: store.sendEnabled(userId) && !forceOff, forceOff });
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/whatsapp/messages?phone= — message rows with their honest
 * statuses: unknown stays unknown, never backfilled.
 */
export async function messagesRequest(
  request: Request,
  context: WhatsAppApiContext,
): Promise<Response> {
  try {
    const userId = requireUser(context);
    const store = storeFor(context);
    if (request.method !== 'GET') return fail('Method not allowed.', 405);
    const phone = new URL(request.url).searchParams.get('phone');
    return ok({ messages: store.messagesFor(userId, phone ?? undefined) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * The webhook. GET is Meta's verification handshake; POST is the signed
 * event stream. No session — the signature is the authentication, and the
 * phone_number_id in the payload metadata routes to the owning account.
 */
export async function webhookRequest(
  request: Request,
  context: Omit<WhatsAppApiContext, 'userId'>,
): Promise<Response> {
  try {
    const verifyToken = context.env?.WHATSAPP_VERIFY_TOKEN;
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      if (
        params.get('hub.mode') === 'subscribe' &&
        verifyToken &&
        params.get('hub.verify_token') === verifyToken
      ) {
        return new Response(params.get('hub.challenge') ?? '', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return fail('Webhook verification failed.', 403);
    }
    if (request.method !== 'POST') return fail('Method not allowed.', 405);

    const rawBody = await request.text();
    const signatureHeader = request.headers.get('x-hub-signature-256');
    if (!context.env?.WHATSAPP_APP_SECRET) {
      return fail('WhatsApp is not configured on this deployment.', 503);
    }
    if (!verifyWebhookSignature(rawBody, signatureHeader, context.env.WHATSAPP_APP_SECRET)) {
      return fail('Webhook signature did not verify.', 401);
    }

    // Route to the owning account via the number Meta addressed.
    let payload: {
      entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[];
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return fail('The webhook body is not valid JSON.', 400);
    }
    const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!phoneNumberId) return fail('No phone_number_id in the webhook payload.', 400);
    const store = storeFor({ ...context, userId: '' });
    const routed = store.accountByPhoneNumberId(phoneNumberId);
    if (!routed) {
      return fail('No connected WhatsApp account for that number.', 404);
    }

    const receipt = await ingestWebhook(
      {
        store: createWhatsAppStore(context.db, { now: context.now, newId: context.newId }),
        userId: routed.userId,
        accountId: routed.account.id,
        appSecret: context.env.WHATSAPP_APP_SECRET,
      },
      { rawBody, signatureHeader },
    );
    return ok({ receipt });
  } catch (error) {
    return handleError(error);
  }
}

export { verifyWebhookSignature };
