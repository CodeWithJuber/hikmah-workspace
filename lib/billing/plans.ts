/** The typed view of what the deployment sells.
 *
 * The catalogue itself lives in server/plans.mjs, because server/auth.mjs needs
 * it and is loaded as plain Node outside the Next bundle. Re-exported rather
 * than restated so the pricing page, the checkout and the entitlement check
 * cannot drift apart.
 */
import {
  PLANS as RAW,
  billingConfigured,
  planById as rawPlanById,
  priceIdFor as rawPriceIdFor,
} from '@/server/plans.mjs';

/** What a person is allowed to do, named from where the money comes.
 *
 *  - `owner`   the deployment's operator. One person, pinned by user id.
 *  - `byok`    brings their own provider key. Costs the deployment nothing, so
 *              it needs no allowance and no metering.
 *  - `managed` runs on the deployment's key, against a monthly allowance.
 */
export type Tier = 'owner' | 'byok' | 'managed';

export function isTier(value: unknown): value is Tier {
  return value === 'owner' || value === 'byok' || value === 'managed';
}

export type Plan = {
  id: string;
  name: string;
  tagline: string;
  tier: Exclude<Tier, 'owner'>;
  priceIdEnv?: string;
  annualPriceIdEnv?: string;
  /** Days of free trial Stripe should grant. Zero means none. */
  trialDays: number;
  /** Tokens per calendar month on the deployment's key. Null means the plan
   * does not use the deployment's key at all. */
  monthlyTokenCap: number | null;
  features: string[];
};

export const PLANS = RAW as Plan[];

export function planById(id: string): Plan | undefined {
  return rawPlanById(id) as Plan | undefined;
}

export function priceIdFor(plan: Plan, annual = false): string {
  return rawPriceIdFor(plan, annual) as string;
}

export { billingConfigured };
