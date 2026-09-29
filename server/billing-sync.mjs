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
 * A trial counts: the whole point of the trial is that it works. A failed
 * renewal (`past_due`) keeps the paid tier while Stripe retries the card —
 * demoting on the first declined charge would be a silent lockout during a
 * window Stripe itself treats as temporary (JEV 2026-09-30, mirror_stripe).
 * The failure is recorded as a billing event so the billing page can say so
 * plainly. Anything else — cancelled, unpaid, incomplete — falls back to the
 * free tier, which keeps every conversation and file and only stops the
 * deployment paying for the models.
 */
export function tierForSubscription(subscription) {
  const status = subscription?.status;
  const active = status === 'active' || status === 'trialing' || status === 'past_due';
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

/** Record a billing event, for the billing page's notices.
 *
 * Module-private: the module's exported recorders (recordPaymentFailure,
 * recordPaymentRecovery) are the vocabulary; this is the shared insert.
 * Takes the raw handle rather than the storage singleton so a test can drive
 * it against an in-memory database. The id is random per call: dedup is the
 * caller's job (see shouldRecordPaymentFailure), because only the caller knows
 * whether this webhook delivery is a redelivery.
 */
function recordBillingEvent(db, userId, kind, detail, createdAt = new Date().toISOString()) {
  if (!userId || !kind) return;
  db.prepare(
    `INSERT INTO billing_events (id, user_id, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'bevt_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    userId,
    kind,
    String(detail ?? ''),
    createdAt,
  );
}

/** A failed renewal, for the billing page's notice. */
function recordPaymentFailure(db, userId, detail, createdAt) {
  recordBillingEvent(db, userId, 'payment_failed', detail, createdAt);
}

/** The card worked again after a failure: the notice must stop saying it did
 * not. Written when a subscription returns to active/trialing with an
 * unresolved failure behind it. */
function recordPaymentRecovery(db, userId, detail, createdAt) {
  recordBillingEvent(db, userId, 'payment_recovered', detail, createdAt);
}

/** The most recent billing event of a kind for a person, or null. */
function latestBillingEvent(db, userId, kind) {
  if (!userId || !kind) return null;
  return (
    db
      .prepare(
        `SELECT kind, detail, created_at FROM billing_events
         WHERE user_id = ? AND kind = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, kind) ?? null
  );
}

/** The most recent failed-renewal event for a person, or null. */
function latestPaymentFailure(db, userId) {
  return latestBillingEvent(db, userId, 'payment_failed');
}

/** Whether a fresh failure is worth recording.
 *
 * Stripe redelivers `customer.subscription.updated` while it retries the card,
 * and every delivery looks like the same failure. A failure already recorded
 * within the last day is that same failure; anything older is a new one.
 * Pure, so the rule can be tested without a database.
 */
function shouldRecordPaymentFailure(latest, now = new Date()) {
  if (!latest) return true;
  const seen = Date.parse(latest.created_at);
  if (!Number.isFinite(seen)) return true;
  return now.getTime() - seen > 24 * 60 * 60 * 1000;
}

/** Decide what the subscription's status change means for billing events.
 *
 * Kept separate from the hook so a test can drive it against an in-memory
 * database: the hook itself only supplies the storage handle and the
 * best-effort try/catch.
 */
export function resolveBillingEvents(db, userId, subscription, now = new Date()) {
  const status = subscription?.status;
  const plan = subscription?.plan ?? '';
  if (status === 'past_due') {
    // A failed renewal is news the person must see, not a silent tier flip:
    // the tier stays paid while Stripe retries (see tierForSubscription), and
    // the event below is what the billing page renders its notice from.
    if (shouldRecordPaymentFailure(latestPaymentFailure(db, userId), now))
      recordPaymentFailure(db, userId, `status=past_due plan=${plan}`, now.toISOString());
  } else if (status === 'active' || status === 'trialing') {
    // The card worked again: resolve any open failure so the billing page
    // stops telling the person a payment failed.
    const failed = latestPaymentFailure(db, userId);
    const recovered = latestBillingEvent(db, userId, 'payment_recovered');
    if (failed && (!recovered || failed.created_at > recovered.created_at))
      recordPaymentRecovery(db, userId, `status=${status} plan=${plan}`, now.toISOString());
  }
}

/** The plugin callbacks, in one object so auth.mjs stays about auth. */
export const subscriptionHooks = {
  onSubscriptionComplete: async ({ subscription }) =>
    setTier(subscriptionUserId(subscription), tierForSubscription(subscription)),
  onSubscriptionUpdate: async ({ subscription }) => {
    const userId = subscriptionUserId(subscription);
    try {
      resolveBillingEvents(getStorage().raw, userId, subscription);
    } catch (error) {
      console.error(
        '[hikmah] billing event not recorded:',
        error instanceof Error ? error.message : error,
      );
    }
    return setTier(userId, tierForSubscription(subscription));
  },
  onSubscriptionCancel: async ({ subscription }) =>
    // Cancelling schedules the end of the period rather than ending it now, so
    // the tier is whatever the status still says. Stripe sends another event
    // when it actually lapses.
    setTier(subscriptionUserId(subscription), tierForSubscription(subscription)),
  onSubscriptionDeleted: async ({ subscription }) =>
    setTier(subscriptionUserId(subscription), 'byok'),
};
