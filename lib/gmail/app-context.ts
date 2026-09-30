/** Wiring Gmail to this deployment's storage, secrets and environment.
 *
 * Separate from `api.ts` so that module stays testable against a bare
 * in-memory database with injected tokens and fetch. The OAuth client is
 * resolved lazily: listing accounts or drafts works without OAuth configured,
 * and only the flows that need Google fail with the setup instructions.
 */
import { getStorage } from '../../server/storage.mjs';
import { createSecretStore } from '../../server/workspace-secrets.mjs';
import {
  oauthClientFromEnv,
  type FetchLike,
  type OAuthClientConfig,
  type TokenStorage,
} from './oauth.ts';
import type { GmailApiContext } from './api.ts';

export type GmailContextOverrides = {
  fetchImpl?: FetchLike;
  tokens?: TokenStorage;
};

/** Build the request context for the Gmail route handlers. */
export function gmailContext(
  request: Request,
  userId: string,
  overrides: GmailContextOverrides = {},
): GmailApiContext {
  const secrets = createSecretStore();
  const tokens: TokenStorage =
    overrides.tokens ??
    ({
      save: (name, bundle) =>
        secrets.save(userId, {
          name,
          destination: 'gmail:oauth',
          value: JSON.stringify(bundle),
        }),
      load: async (name) => {
        const raw = await secrets.resolve(userId, name, 'gmail:oauth', true);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as {
            accessToken: string;
            refreshToken: string;
            expiresAt: number;
          };
        } catch {
          return null;
        }
      },
      remove: (name) => secrets.remove(userId, name),
    } satisfies TokenStorage);

  let client: OAuthClientConfig | null = null;
  let clientError: Error | null = null;
  const resolveClient = (): OAuthClientConfig | null => {
    if (client || clientError) return client;
    try {
      const base = process.env.BETTER_AUTH_URL || new URL(request.url).origin;
      client = oauthClientFromEnv(process.env, base);
    } catch (error) {
      clientError = error as Error;
    }
    return client;
  };

  return {
    db: getStorage().raw,
    userId,
    fetchImpl: overrides.fetchImpl ?? fetch,
    tokens,
    get oauthClient() {
      return resolveClient();
    },
    env: process.env,
  };
}
