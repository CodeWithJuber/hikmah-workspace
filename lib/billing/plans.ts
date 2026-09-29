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
  priceLabelFor as rawPriceLabelFor,
  trialTermsFor as rawTrialTermsFor,
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
  /** An amount fixed for every deployment, such as the free plan's zero. */
  price?: string;
  /** The variable holding this plan's amount, when it is a deployment's to set. */
  priceEnv?: string;
  /** The line under the amount: what the money buys and how it recurs. */
  priceNote?: string;
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

/** What the card prints where the price goes. Empty when unset. */
export function priceLabelFor(plan: Plan): string {
  return rawPriceLabelFor(plan) as string;
}

/** The trial's terms, stated exactly: what ends, when, what happens after. */
export function trialTermsFor(plan: Plan): string {
  return rawTrialTermsFor(plan) as string;
}

export { billingConfigured };
