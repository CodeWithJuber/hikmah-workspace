/** What the deployment sells, in one place.
 *
 * The pricing page, the checkout call and the entitlement check all read this,
 * so the page can never advertise a plan the checkout does not know about or a
 * limit the run route does not enforce. Prices live in Stripe; only the price
 * ids are named here, and only from the environment, so a test-mode and a live
 * deployment differ by configuration rather than by code.
 */

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
  /** Stable identifier. Matches the plan name given to the Stripe plugin. */
  id: string;
  name: string;
  tagline: string;
  tier: Exclude<Tier, 'owner'>;
  /** Read from the environment at call time, not at import: the same build runs
   * in test mode and in production. Empty means this plan cannot be bought,
   * which is exactly right for the free one. */
  priceIdEnv?: string;
  annualPriceIdEnv?: string;
  /** Days of free trial Stripe should grant. Zero means none. */
  trialDays: number;
  /** Tokens per calendar month on the deployment's key. Null means the plan
   * does not use the deployment's key at all. */
  monthlyTokenCap: number | null;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Bring your own key. Everything else included.',
    tier: 'byok',
    trialDays: 0,
    monthlyTokenCap: null,
    features: [
      'Your own OpenRouter key, so you pay your provider directly',
      'Every model your key can reach, including the free ones',
      'Runs that survive a closed tab',
      'Files, code and the JavaScript sandbox',
      'Qur’an, web search and page reading',
      'Unlimited conversations',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'No key to manage. We supply the models.',
    tier: 'managed',
    priceIdEnv: 'STRIPE_PRICE_PRO',
    annualPriceIdEnv: 'STRIPE_PRICE_PRO_ANNUAL',
    trialDays: 14,
    monthlyTokenCap: 5_000_000,
    features: [
      'Everything in Free, with no key to obtain',
      '5 million tokens a month',
      'Image and speech generation',
      'Priority on the run queue',
      '14 days free, cancel any time',
    ],
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** The Stripe price id for a plan, or '' when this deployment has not been
 * given one. A plan with no price id is shown but cannot be checked out, which
 * is a better failure than a checkout that 500s. */
export function priceIdFor(plan: Plan, annual = false): string {
  const key = annual ? plan.annualPriceIdEnv : plan.priceIdEnv;
  return (key && process.env[key]) || '';
}

/** Whether this deployment can take money at all. */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}
