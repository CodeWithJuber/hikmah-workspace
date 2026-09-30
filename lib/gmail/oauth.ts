/** Google OAuth for Gmail: the authorization-code flow, injectable and mocked.
 *
 * Nothing here reads the environment or the secret vault directly: the caller
 * passes the OAuth client (id, secret, redirect URI) and the token storage, so
 * the whole flow runs against a stubbed fetch in tests and never touches a
 * real Google account. The route file wires the real env and the vault.
 *
 * Incremental grants are the point: the owner connects `read` first, and a
 * later `send` grant merges its scopes into the same account row rather than
 * replacing it.
 */
import { scopesForGrant, type GmailGrantKind } from './scopes.ts';

export class GmailOAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GmailOAuthError';
    this.status = status;
  }
}

export type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Persisted token bundle behind one account. */
export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type TokenStorage = {
  save: (secretName: string, tokens: StoredTokens) => Promise<void>;
  load: (secretName: string) => Promise<StoredTokens | null>;
  remove: (secretName: string) => Promise<void>;
};

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://www.googleapis.com/gmail/v1/users/me/profile';

/**
 * Resolve the OAuth client from the environment.
 *
 * GMAIL_CLIENT_ID/SECRET are the Gmail-specific client; they fall back to the
 * sign-in client's GOOGLE_CLIENT_ID/SECRET, since many deployments will use
 * one Google Cloud project. The redirect URI must be registered in that
 * project's console: <base>/api/gmail/oauth/callback.
 */
export function oauthClientFromEnv(env: NodeJS.ProcessEnv, baseUrl: string): OAuthClientConfig {
  const clientId = env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret)
    throw new GmailOAuthError(
      'Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET' +
        ' (or reuse the sign-in client via GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' +
        ' and register the redirect URI in the Google Cloud console.',
      503,
    );
  return {
    clientId,
    clientSecret,
    redirectUri: baseUrl.replace(/\/$/, '') + '/api/gmail/oauth/callback',
  };
}

/** The Google consent URL the owner visits. `state` is the CSRF token. */
export function authorizationUrl(
  client: OAuthClientConfig,
  kind: GmailGrantKind,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: scopesForGrant(kind).join(' '),
    access_type: 'offline',
    // Ask for a refresh token every time: without it a later token rotation
    // leaves the account unreadable until the owner reconnects.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function exchange(
  fetchImpl: FetchLike,
  client: OAuthClientConfig,
  body: Record<string, string>,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new GmailOAuthError('Could not reach Google to finish the sign-in.', 502);
  }
  const parsed = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok)
    throw new GmailOAuthError(
      `Google refused the token request: ${parsed.error_description ?? parsed.error ?? response.status}.`,
      502,
    );
  return parsed;
}

/**
 * Trade the callback's code for tokens, confirm the account's address, and
 * persist the bundle in the vault. Returns the email and the scopes Google
 * actually granted — the store records those, never what was asked for.
 */
export async function exchangeCodeForTokens(
  fetchImpl: FetchLike,
  client: OAuthClientConfig,
  tokens: TokenStorage,
  secretName: string,
  code: string,
): Promise<{ email: string; displayName: string | null; grantedScopes: string[] }> {
  const parsed = await exchange(fetchImpl, client, {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!parsed.access_token) throw new GmailOAuthError('Google returned no access token.', 502);
  // A callback without a refresh token (the owner approved before, and the
  // prompt did not force consent) cannot survive a token rotation: refuse it
  // now rather than connecting an account that dies in an hour.
  if (!parsed.refresh_token)
    throw new GmailOAuthError(
      'Google did not return a refresh token. Reconnect and approve the consent screen again.',
      502,
    );
  let profile: Response;
  try {
    profile = await fetchImpl(PROFILE_URL, {
      headers: { authorization: `Bearer ${parsed.access_token}` },
    });
  } catch {
    throw new GmailOAuthError('Could not reach Google to confirm the account.', 502);
  }
  if (!profile.ok) throw new GmailOAuthError('Google would not confirm the account.', 502);
  const account = (await profile.json().catch(() => ({}))) as {
    emailAddress?: string;
  };
  if (!account.emailAddress) throw new GmailOAuthError('Google confirmed no email address.', 502);
  const expiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000;
  await tokens.save(secretName, {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt,
  });
  return {
    email: account.emailAddress,
    displayName: null,
    grantedScopes: (parsed.scope ?? '').split(' ').filter((scope) => scope.length > 0),
  };
}

/**
 * A live access token for the account, refreshing when the stored one is
 * stale. The refresh token never leaves this function.
 */
export async function accessToken(
  fetchImpl: FetchLike,
  client: OAuthClientConfig,
  tokens: TokenStorage,
  secretName: string,
  forceRefresh = false,
): Promise<string> {
  const stored = await tokens.load(secretName);
  if (!stored) throw new GmailOAuthError('That Gmail account is not connected.', 401);
  // Refresh a minute early so a token that dies mid-request cannot strand us.
  if (!forceRefresh && stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
  const parsed = await exchange(fetchImpl, client, {
    refresh_token: stored.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
  });
  if (!parsed.access_token) throw new GmailOAuthError('Google refused to refresh the token.', 502);
  const next: StoredTokens = {
    accessToken: parsed.access_token,
    // Google sometimes withholds a new refresh token: keep the old one.
    refreshToken: parsed.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
  await tokens.save(secretName, next);
  return next.accessToken;
}
