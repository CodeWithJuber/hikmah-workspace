/** Keep the app's tier row in step with Stripe.
 *
 * Better Auth's Stripe plugin owns the subscription rows, and they live in
 * auth.sqlite; entitlements are decided from user_tiers in workspace.sqlite.
 * Rather than have the run route read across two databases on every message,
 * the plugin's own callbacks write the tier once, when it changes.
 *
 * Plain JavaScript for the same reason as server/plans.mjs: server/auth.mjs is
 * loaded outside the Next bundle and cannot import TypeScript.
 */
import { getStorage } from './storage.mjs';
import { planById } from './plans.mjs';

/** Write a tier, or do nothing if the deployment has no database yet.
 *
 * Best effort on purpose. A webhook Stripe has already accepted must not be
 * answered with a 500 because a row could not be written: Stripe would retry
 * the whole event, and the subscription itself is already correct. A missed
 * write leaves the person on the free tier, which is visible and fixable; a
 * failed webhook is neither.
 */
export function setTier(userId, tier) {
  if (!userId) return;
  try {
    getStorage()
      .raw.prepare(
        `INSERT INTO user_tiers (user_id, tier, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
      )
      .run(userId, tier, new Date().toISOString());
  } catch (error) {
    console.error('[hikmah] tier not written:', error instanceof Error ? error.message : error);
  }
}

/** Which tier a Stripe subscription grants right now.
 *
 * A trial counts: the whole point of the trial is that it works. Anything else
 * — cancelled, unpaid, past due, incomplete — falls back to the free tier,
 * which keeps every conversation and file and only stops the deployment paying
 * for the models.
 */
export function tierForSubscription(subscription) {
  const active = subscription?.status === 'active' || subscription?.status === 'trialing';
  if (!active) return 'byok';
  return planById(subscription?.plan)?.tier ?? 'byok';
}

/** The user id a subscription belongs to.
 *
 * `referenceId` is what the plugin bills against, and defaults to the user id
 * for a personal subscription. Named here so the assumption is written down
 * rather than assumed at four call sites.
 */
export function subscriptionUserId(subscription) {
  return subscription?.referenceId ?? subscription?.userId ?? '';
}

/** The plugin callbacks, in one object so auth.mjs stays about auth. */
export const subscriptionHooks = {
  onSubscriptionComplete: async ({ subscription }) =>
    setTier(subscriptionUserId(subscription), tierForSubscription(subscription)),
  onSubscriptionUpdate: async ({ subscription }) =>
    setTier(subscriptionUserId(subscription), tierForSubscription(subscription)),
  onSubscriptionCancel: async ({ subscription }) =>
    // Cancelling schedules the end of the period rather than ending it now, so
    // the tier is whatever the status still says. Stripe sends another event
    // when it actually lapses.
    setTier(subscriptionUserId(subscription), tierForSubscription(subscription)),
  onSubscriptionDeleted: async ({ subscription }) =>
    setTier(subscriptionUserId(subscription), 'byok'),
};
