/** Wiring WhatsApp to this deployment's storage, secrets and environment.
 *
 * Separate from `api.ts` so that module stays testable against a bare
 * in-memory database with injected secrets and fetch. The access token is
 * resolved lazily from the vault; listing accounts or reading consent works
 * without it, and only a live send fails with the setup instructions.
 */
import { getStorage } from '../../server/storage.mjs';
import { createSecretStore } from '../../server/workspace-secrets.mjs';
import type { FetchLike, WhatsAppApiContext } from './api.ts';
import type { WhatsAppAccount } from './store.ts';

export type WhatsAppContextOverrides = {
  fetchImpl?: FetchLike;
  getAccessToken?: (account: WhatsAppAccount) => Promise<string | null>;
};

/** Build the request context for the WhatsApp route handlers. */
export function whatsappContext(
  request: Request,
  userId: string | null,
  overrides: WhatsAppContextOverrides = {},
): WhatsAppApiContext {
  const secrets = createSecretStore();
  const getAccessToken =
    overrides.getAccessToken ??
    (async (account: WhatsAppAccount) => {
      if (!userId) return null;
      return secrets.resolve(userId, account.tokenSecret, 'whatsapp:token', true);
    });

  return {
    db: getStorage().raw,
    userId,
    fetchImpl: overrides.fetchImpl ?? fetch,
    getAccessToken,
    env: process.env,
  };
}
