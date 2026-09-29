/** Tiers and metered usage, over the raw sqlite handle.
 *
 * Same shape and the same reasons as lib/runs/store.ts: prepared once, no Next
 * imports, so the worker and a test can both use it without a server.
 */
import { isTier, type Tier } from './plans.ts';
import { periodStart } from './entitlements.ts';
import type { SqliteHandle } from '../runs/store.ts';

export type UsageEvent = {
  id: string;
  userId: string;
  runId: string;
  model: string;
  /** Whether the deployment's own key paid for this. */
  metered: boolean;
  inputTokens: number;
  outputTokens: number;
};

export function createBillingStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    getTier: db.prepare('SELECT tier FROM user_tiers WHERE user_id = ?'),
    setTier: db.prepare(
      `INSERT INTO user_tiers (user_id, tier, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    ),
    getOwner: db.prepare("SELECT user_id FROM kernel_owners WHERE id = 'owner'"),
    insertUsage: db.prepare(
      `INSERT INTO usage_events
         (id, user_id, run_id, model, metered, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Only metered rows count against an allowance: a run on the person's own
    // key is recorded so it can be shown to them, not so it can be rationed.
    sumMetered: db.prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
       FROM usage_events
       WHERE user_id = ? AND metered = 1 AND created_at >= ?`,
    ),
    sumAll: db.prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total,
              COUNT(*) AS runs
       FROM usage_events
       WHERE user_id = ? AND created_at >= ?`,
    ),
    insertConsent: db.prepare(
      `INSERT INTO billing_consents
         (id, user_id, plan_id, price_label, terms, agreed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    consentsFor: db.prepare(
      `SELECT id, user_id, plan_id, price_label, terms, agreed_at
       FROM billing_consents WHERE user_id = ? ORDER BY agreed_at DESC`,
    ),
    latestBillingEvent: db.prepare(
      `SELECT kind, detail, created_at FROM billing_events
       WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
    ),
  };

  return {
    /** The saved tier, or null when the person has never been moved off the
     * default. Absence is meaningful, so it is not collapsed to 'byok' here. */
    savedTier(userId: string): Tier | null {
      const row = statements.getTier.get(userId) as { tier?: string } | undefined;
      return row && isTier(row.tier) ? row.tier : null;
    },

    setTier(userId: string, tier: Tier): void {
      statements.setTier.run(userId, tier, now());
    },

    /** Whoever `kernel_owners` names, or null before the owner has signed in.
     * Read rather than bootstrapped: deciding what someone may do must not have
     * the side effect of appointing them. */
    ownerUserId(): string | null {
      const row = statements.getOwner.get() as { user_id?: string } | undefined;
      return row?.user_id ?? null;
    },

    recordUsage(event: UsageEvent): void {
      statements.insertUsage.run(
        event.id,
        event.userId,
        event.runId,
        event.model,
        event.metered ? 1 : 0,
        Math.max(0, Math.round(event.inputTokens)),
        Math.max(0, Math.round(event.outputTokens)),
        now(),
      );
    },

    /** Tokens charged to the deployment this calendar month. */
    meteredThisMonth(userId: string, from = periodStart()): number {
      return (statements.sumMetered.get(userId, from) as { total: number }).total;
    },

    /** Everything the person has run this month, their own key included. What
     * the billing page shows; not what the cap counts. */
    usageThisMonth(userId: string, from = periodStart()): { tokens: number; runs: number } {
      const row = statements.sumAll.get(userId, from) as { total: number; runs: number };
      return { tokens: row.total, runs: row.runs };
    },

    /** Record the explicit consent to be charged, with the exact terms agreed
     * to. Written before any checkout opens: no charge without this row. */
    recordConsent(consent: {
      id: string;
      userId: string;
      planId: string;
      priceLabel: string;
      terms: string;
    }): void {
      statements.insertConsent.run(
        consent.id,
        consent.userId,
        consent.planId,
        consent.priceLabel,
        consent.terms,
        now(),
      );
    },

    /** The consent history, newest first. Append-only: agreeing again adds a
     * row rather than rewriting what was agreed before. */
    consentsFor(
      userId: string,
    ): { id: string; plan_id: string; price_label: string; terms: string; agreed_at: string }[] {
      return statements.consentsFor.all(userId) as {
        id: string;
        plan_id: string;
        price_label: string;
        terms: string;
        agreed_at: string;
      }[];
    },

    /** The most recent billing event of a kind for a person — what the billing
     * page's notices render from — or null. */
    latestBillingEvent(
      userId: string,
      kind: string,
    ): { kind: string; detail: string; created_at: string } | null {
      return (
        (statements.latestBillingEvent.get(userId, kind) as
          | {
              kind: string;
              detail: string;
              created_at: string;
            }
          | undefined) ?? null
      );
    },

    /** The unresolved payment failure to tell the person about, or null.
     *
     * A failure Stripe later collected writes a `payment_recovered` event when
     * the subscription returns to active: only a failure with no later
     * recovery is still news. Keeps the billing page from crying wolf after
     * the card worked again. */
    paymentFailureNotice(userId: string): { at: string } | null {
      const latest = (kind: string) =>
        (statements.latestBillingEvent.get(userId, kind) as { created_at: string } | undefined) ??
        null;
      const failed = latest('payment_failed');
      if (!failed) return null;
      const recovered = latest('payment_recovered');
      if (recovered && recovered.created_at >= failed.created_at) return null;
      return { at: failed.created_at };
    },
  };
}

export type BillingStore = ReturnType<typeof createBillingStore>;
