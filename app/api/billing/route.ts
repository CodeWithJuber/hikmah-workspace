import { getChatGPTUser } from '../../chatgpt-auth';
import { billingStore, entitlementsForUser } from '@/lib/billing/server';
import { PLANS, billingConfigured, priceIdFor } from '@/lib/billing/plans';
import { periodStart } from '@/lib/billing/entitlements';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/**
 * What this person is on, and what they have used.
 *
 * The plan catalogue is served alongside rather than compiled into the page, so
 * a deployment that has been given no Stripe price says so instead of offering
 * a button that cannot work. Prices themselves are not here: they live in
 * Stripe, and Checkout is what quotes them.
 */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  const entitlements = entitlementsForUser(user);
  const from = periodStart();
  const usage = billingStore().usageThisMonth(user.userId, from);
  return Response.json(
    {
      tier: entitlements.tier,
      monthlyTokenCap: entitlements.monthlyTokenCap,
      execution: entitlements.execution,
      // What counts against the allowance, which is not the same as what they
      // ran: a turn on their own key costs the deployment nothing.
      metered: billingStore().meteredThisMonth(user.userId, from),
      usage,
      periodStart: from,
      configured: billingConfigured(),
      plans: PLANS.map((plan) => ({
        id: plan.id,
        name: plan.name,
        tagline: plan.tagline,
        tier: plan.tier,
        trialDays: plan.trialDays,
        monthlyTokenCap: plan.monthlyTokenCap,
        features: plan.features,
        purchasable: Boolean(priceIdFor(plan)),
        annual: Boolean(priceIdFor(plan, true)),
      })),
    },
    { headers },
  );
}
