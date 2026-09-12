/** Entitlements for a request, over the deployment's own database.
 *
 * The thin Next-facing layer: everything it decides lives in the pure modules
 * beside it, so this file only fetches the four facts they need.
 */
import { getStorage } from '@/server/storage.mjs';
import { createBillingStore, type BillingStore } from './store.ts';
import { entitlementsFor, resolveTier, type Entitlements } from './entitlements.ts';

let cached: BillingStore | undefined;

export function billingStore(): BillingStore {
  cached ??= createBillingStore(getStorage().raw);
  return cached;
}

/** What this person may do. Never writes: deciding what someone is allowed must
 * not have the side effect of granting it. */
export function entitlementsForUser(user: { userId: string; email: string }): Entitlements {
  const store = billingStore();
  return entitlementsFor(
    resolveTier({
      userId: user.userId,
      email: user.email,
      ownerUserId: store.ownerUserId(),
      ownerEmail: process.env.HIKMAH_OWNER_EMAIL ?? '',
      saved: store.savedTier(user.userId),
    }),
  );
}
