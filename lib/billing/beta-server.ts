/** The beta store for a request, over the deployment's own database.
 *
 * The thin Next-facing layer beside lib/billing/server.ts: one cached store
 * per process, the same `getStorage().raw` handle the billing store uses, so
 * trials and stub subscriptions live in the same database as the tiers.
 */
import { getStorage } from '@/server/storage.mjs';
import { createBetaStore, type BetaStore } from './beta-store.ts';

let cached: BetaStore | undefined;

export function betaStore(): BetaStore {
  cached ??= createBetaStore(getStorage().raw);
  return cached;
}
