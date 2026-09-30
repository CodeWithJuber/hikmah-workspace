/** The Gmail surface behind the settings screen.
 *
 * The route files own sign-in and the Origin check; this owns the request
 * against the store and the Gmail API, so the whole flow — account selection,
 * scope gating, the approval gate, the send flag and idempotent send — is
 * testable without the app's module aliases and without touching Google.
 *
 * The rules, in the order every send enforces them:
 *  1. sending is switched on for this owner (off by default), and not
 *     force-disabled for the deployment;
 *  2. the approval token is real, unused, unexpired, and covers the draft's
 *     exact current content;
 *  3. the account actually holds a send scope — a stored grant is a claim,
 *     the scope string is the enforcement;
 *  4. the idempotency key has not been seen: a retry returns the stored
 *     result instead of sending again.
 */
import { DatabaseSync } from 'node:sqlite';
import { GmailStoreError, approvalTokenHash, createGmailStore, draftContentHash } from './store.ts';
import { canRead, canSend, mergeScopes, scopeLabels, type GmailGrantKind } from './scopes.ts';
import {
  GmailOAuthError,
  accessToken,
  authorizationUrl,
  exchangeCodeForTokens,
  oauthClientFromEnv,
  type FetchLike,
  type OAuthClientConfig,
  type TokenStorage,
} from './oauth.ts';
import { GmailClientError, createGmailClient } from './client.ts';

export type GmailApiContext = {
  db: DatabaseSync;
  userId: string | null;
  fetchImpl: FetchLike;
  tokens: TokenStorage;
  /** Null when OAuth is not configured; handlers that need Google refuse with
   * setup instructions instead of failing at context build time. */
  oauthClient: OAuthClientConfig | null;
  /** Deployment env, for the send force-off switch. */
  env?: Record<string, string | undefined>;
  now?: () => string;
  newId?: () => string;
};

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const ok = (body: unknown) => Response.json(body, { headers });

/** What the settings screen shows for an account: granted scopes, never the
 * secret that holds the tokens. */
const publicAccount = (account: {
  id: string;
  email: string;
  displayName: string | null;
  scopes: string;
}) => ({
  id: account.id,
  email: account.email,
  displayName: account.displayName,
  scopes: account.scopes,
  scopeLabels: scopeLabels(account.scopes),
  canRead: canRead(account.scopes),
  canSend: canSend(account.scopes),
});

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;

/** The OAuth flows refuse with setup instructions when the deployment has no
 * Google client configured — the failure names what the owner must provide. */
function requireOAuthClient(context: GmailApiContext): OAuthClientConfig {
  if (!context.oauthClient)
    throw new GmailOAuthError(
      'Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET' +
        ' (or reuse the sign-in client via GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' +
        ' and register the redirect URI in the Google Cloud console.',
      503,
    );
  return context.oauthClient;
}

function sendBlocked(
  context: GmailApiContext,
  store: { sendEnabled: (u: string) => boolean },
  userId: string,
): string | null {
  if (context.env?.GMAIL_SEND_FORCE_OFF === '1')
    return 'Sending mail is switched off for this workspace.';
  if (!store.sendEnabled(userId))
    return 'Sending mail is switched off. Turn it on in Integrations first.';
  return null;
}

function tokenSecretName(newId: () => string): string {
  // The vault only accepts uppercase names: GMAIL_OAUTH_ + 32 hex chars.
  return `GMAIL_OAUTH_${newId().replace(/-/g, '').toUpperCase().slice(0, 32)}`;
}

/** Every read/send/draft call names its account: there is no default, so a
 * second account can never silently receive the first one's mail. */
function requireAccountId(params: URLSearchParams): string {
  const accountId = params.get('accountId') ?? '';
  if (!accountId) throw new GmailStoreError('Choose one of your connected Gmail accounts.');
  return accountId;
}

/** GET /api/gmail/accounts — the connected accounts. DELETE ?id= — disconnect. */
export async function accountsRequest(
  request: Request,
  context: GmailApiContext,
): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const userId = context.userId;
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const listing = () => ok({ accounts: store.accounts(userId).map(publicAccount) });
  try {
    if (request.method === 'GET') return listing();
    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id') ?? '';
      const account = store.account(id, userId);
      if (!account) return fail('That Gmail account is not connected here.', 404);
      store.removeAccount(id, userId);
      await context.tokens.remove(account.tokenSecret).catch(() => {});
      return listing();
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    throw error;
  }
}

/**
 * POST /api/gmail/oauth {kind:"read"|"send", accountId?} — mint a CSRF state
 * and return the Google consent URL.
 * GET /api/gmail/oauth?code=..&state=.. — the redirect target registered in
 * the Google Cloud console; finishes the grant and lands back in Integrations.
 */
export async function oauthRequest(request: Request, context: GmailApiContext): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const userId = context.userId;
  const newId = context.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const base = new URL(request.url).origin;
  const back = (gmail: string, extra = '') =>
    Response.redirect(`${base}/connections?gmail=${gmail}${extra}`, 302);

  try {
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail('Expected a JSON request body.', 400);
      const kind = body.kind === 'send' ? 'send' : 'read';
      const accountId = body.accountId ? String(body.accountId) : undefined;
      if (accountId && !store.account(accountId, userId))
        return fail('That Gmail account is not connected here.', 404);
      const state = newId() + newId();
      store.saveOAuthState(state, userId, kind, accountId);
      return ok({
        url: authorizationUrl(requireOAuthClient(context), kind as GmailGrantKind, state),
      });
    }

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const code = params.get('code') ?? '';
      const state = params.get('state') ?? '';
      const saved = store.takeOAuthState(state);
      if (!code || !saved || saved.userId !== userId) return back('error', '&reason=expired');
      if (Date.parse(saved.createdAt) < Date.now() - OAUTH_STATE_TTL_MS)
        return back('error', '&reason=expired');
      store.pruneOAuthStates(new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString());
      const existing = saved.accountId ? store.account(saved.accountId, userId) : undefined;
      const secretName = existing?.tokenSecret ?? tokenSecretName(newId);
      const { email, displayName, grantedScopes } = await exchangeCodeForTokens(
        context.fetchImpl,
        requireOAuthClient(context),
        context.tokens,
        secretName,
        code,
      );
      const account = store.upsertAccount(userId, email, {
        displayName,
        scopes: mergeScopes(existing?.scopes, grantedScopes),
        tokenSecret: secretName,
      });
      return back('connected', `&email=${encodeURIComponent(account.email)}`);
    }

    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    if (error instanceof GmailOAuthError) return fail(error.message, error.status);
    throw error;
  }
}

/** GET /api/gmail/messages?accountId=&q=&pageToken= — list; &id= — read one. */
export async function messagesRequest(
  request: Request,
  context: GmailApiContext,
): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  if (request.method !== 'GET') return fail('Method not allowed.', 405);
  const userId = context.userId;
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const params = new URL(request.url).searchParams;
  try {
    const account = store.account(requireAccountId(params), userId);
    if (!account) return fail('That Gmail account is not connected here.', 404);
    if (!canRead(account.scopes))
      return fail(
        'This account was connected for sending only. Add read permission to read mail.',
        403,
      );
    const client = createGmailClient({
      fetchImpl: context.fetchImpl,
      tokenFor: (force) =>
        accessToken(
          context.fetchImpl,
          requireOAuthClient(context),
          context.tokens,
          account.tokenSecret,
          force,
        ),
    });
    const id = params.get('id') ?? '';
    if (id) return ok({ message: await client.getMessage(id) });
    return ok({
      ...(await client.listMessages({
        q: params.get('q') ?? undefined,
        pageToken: params.get('pageToken') ?? undefined,
      })),
    });
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    if (error instanceof GmailClientError) return fail(error.message, error.status);
    if (error instanceof GmailOAuthError) return fail(error.message, error.status);
    throw error;
  }
}

/**
 * GET /api/gmail/drafts?accountId= — local drafts.
 * POST — create {accountId, to[], cc[], subject, body, inReplyTo?}.
 * PATCH — update {id, to?, cc?, subject?, body?}.
 * DELETE ?id= — discard.
 */
export async function draftsRequest(request: Request, context: GmailApiContext): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const userId = context.userId;
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const params = new URL(request.url).searchParams;
  try {
    if (request.method === 'GET')
      return ok({ drafts: store.drafts(userId, requireAccountId(params)) });
    if (request.method === 'DELETE') {
      const id = params.get('id') ?? '';
      if (!store.draft(id, userId)) return fail('That draft is not saved here.', 404);
      store.deleteDraft(id, userId);
      return ok({ deleted: true });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail('Expected a JSON request body.', 400);
    if (request.method === 'POST') {
      const draft = store.createDraft(userId, String(body.accountId ?? ''), {
        to: Array.isArray(body.to) ? (body.to as string[]) : [],
        cc: Array.isArray(body.cc) ? (body.cc as string[]) : [],
        subject: String(body.subject ?? ''),
        body: String(body.body ?? ''),
        inReplyTo: body.inReplyTo ? String(body.inReplyTo) : undefined,
      });
      return ok({ draft });
    }
    if (request.method === 'PATCH') {
      const draft = store.updateDraft(String(body.id ?? ''), userId, {
        to: Array.isArray(body.to) ? (body.to as string[]) : undefined,
        cc: Array.isArray(body.cc) ? (body.cc as string[]) : undefined,
        subject: body.subject !== undefined ? String(body.subject) : undefined,
        body: body.body !== undefined ? String(body.body) : undefined,
      });
      return ok({ draft });
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    throw error;
  }
}

/**
 * POST /api/gmail/send {action:"approve", draftId, idempotencyKey?} — mint a
 * single-use approval token bound to the draft's exact content.
 * POST /api/gmail/send {action:"send", draftId, approvalToken, idempotencyKey}
 * — send, exactly once per key.
 */
export async function sendRequest(request: Request, context: GmailApiContext): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  if (request.method !== 'POST') return fail('Method not allowed.', 405);
  const userId = context.userId;
  const newId = context.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail('Expected a JSON request body.', 400);
  const action = String(body.action ?? '');
  const draftId = String(body.draftId ?? '');
  const idempotencyKey =
    String(body.idempotencyKey ?? '') ||
    request.headers.get('x-idempotency-key') ||
    `gmail-${newId()}`;

  try {
    const draft = store.draft(draftId, userId);
    if (!draft) return fail('That draft is not saved here.', 404);
    const account = store.account(draft.accountId, userId);
    if (!account) return fail('That Gmail account is not connected here.', 404);
    const blocked = sendBlocked(context, store, userId);
    if (blocked) return fail(blocked, 403);
    if (!canSend(account.scopes))
      return fail(
        'This account was connected for reading only. Grant send permission to send mail.',
        403,
      );

    if (action === 'approve') {
      const { token, expiresAt } = store.approveDraft(draftId, userId, {
        now: context.now,
        ttlMs: APPROVAL_TTL_MS,
      });
      return ok({ approvalToken: token, expiresAt, idempotencyKey });
    }

    if (action === 'send') {
      const approvalToken = String(body.approvalToken ?? '');
      if (!approvalToken) return fail('Sending needs a fresh approval token.', 403);
      const approval = store.approval(approvalToken);
      const currentHash = draftContentHash(draft);
      if (
        !approval ||
        approval.userId !== userId ||
        approval.accountId !== account.id ||
        approval.draftId !== draft.id ||
        approval.usedAt !== null ||
        Date.parse(approval.expiresAt) <= Date.now() ||
        approval.contentHash !== currentHash
      )
        return fail(
          'That approval is missing, used, expired, or the draft changed since it was approved. Approve the draft again.',
          403,
        );

      // Idempotency before the API call: a retry with the same key returns
      // the stored outcome instead of sending a second mail.
      const existing = store.claimSend(idempotencyKey, userId, account.id, draft.id);
      if (existing) {
        if (existing.status === 'sent')
          return ok({
            duplicate: true,
            gmailMessageId: existing.gmailMessageId,
            idempotencyKey,
          });
        return fail(
          'A send with this idempotency key is already in flight. Retry with the same key to learn its outcome.',
          409,
        );
      }

      const client = createGmailClient({
        fetchImpl: context.fetchImpl,
        tokenFor: (force) =>
          accessToken(
            context.fetchImpl,
            requireOAuthClient(context),
            context.tokens,
            account.tokenSecret,
            force,
          ),
      });
      const sent = await client.sendMessage({
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: draft.inReplyTo,
      });
      // The approval dies with the send it authorized: it cannot authorize a
      // second one even if it is replayed.
      store.useApproval(approvalToken);
      store.completeSend(idempotencyKey, sent.id);
      store.deleteDraft(draft.id, userId);
      return ok({ sent: true, gmailMessageId: sent.id, idempotencyKey });
    }

    return fail('Unknown action. Use "approve" or "send".', 400);
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    if (error instanceof GmailClientError) return fail(error.message, error.status);
    if (error instanceof GmailOAuthError) return fail(error.message, error.status);
    throw error;
  }
}

export { oauthClientFromEnv, approvalTokenHash };

/**
 * GET /api/gmail/settings — the send switch. PATCH {sendEnabled} — flip it.
 * Switching sending on is an explicit owner act; it starts off and the
 * deployment can force it off with GMAIL_SEND_FORCE_OFF=1.
 */
export async function settingsRequest(
  request: Request,
  context: GmailApiContext,
): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const userId = context.userId;
  const store = createGmailStore(context.db, { now: context.now, newId: context.newId });
  const forceOff = context.env?.GMAIL_SEND_FORCE_OFF === '1';
  try {
    if (request.method === 'GET')
      return ok({ sendEnabled: store.sendEnabled(userId) && !forceOff, forceOff });
    if (request.method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.sendEnabled !== 'boolean')
        return fail('Say whether sending should be on or off.', 400);
      store.setSendEnabled(userId, body.sendEnabled);
      return ok({ sendEnabled: store.sendEnabled(userId) && !forceOff, forceOff });
    }
    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof GmailStoreError) return fail(error.message, error.status);
    throw error;
  }
}
