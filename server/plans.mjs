/** What the deployment sells.
 *
 * Plain JavaScript and in server/ rather than lib/, because server/auth.mjs is
 * loaded by scripts/start.mjs as ordinary Node, outside the Next bundle, so it
 * cannot import TypeScript. The typed view in lib/billing/plans.ts re-exports
 * this rather than restating it: the pricing page, the checkout call and the
 * entitlement check must never disagree about what a plan includes.
 *
 * Prices live in Stripe. Only the price ids are named here, and only through
 * the environment, so a test-mode and a live deployment differ by configuration
 * rather than by code.
 */

export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Bring your own key. Everything else included.',
    tier: 'byok',
    trialDays: 0,
    monthlyTokenCap: null,
    // Which provider is a setup detail, not a selling point. Naming one here
    // tells every visitor what this is built on and ties the pricing page to a
    // third party; the Connection panel names it, links to it, and can name a
    // second one later without any of this changing.
    features: [
      'Your own model key, so you pay your provider directly',
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

export function planById(id) {
  return PLANS.find((plan) => plan.id === id);
}

/** The Stripe price id for a plan, or '' when this deployment has not been
 * given one. A plan with no price id is shown but cannot be checked out, which
 * is a better failure than a checkout that 500s. */
export function priceIdFor(plan, annual = false) {
  const key = annual ? plan.annualPriceIdEnv : plan.priceIdEnv;
  return (key && process.env[key]) || '';
}

/** Whether this deployment can take money at all. */
export function billingConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

/** The plans the Stripe plugin should know about: the paid ones that this
 * deployment has actually been given a price for. */
export function stripePlans() {
  return PLANS.filter((plan) => plan.tier === 'managed' && priceIdFor(plan)).map((plan) => ({
    name: plan.id,
    priceId: priceIdFor(plan),
    ...(priceIdFor(plan, true) ? { annualDiscountPriceId: priceIdFor(plan, true) } : {}),
    ...(plan.trialDays ? { freeTrial: { days: plan.trialDays } } : {}),
  }));
}
