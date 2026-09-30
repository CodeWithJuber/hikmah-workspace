import { getChatGPTUser } from '../../../chatgpt-auth';
import { PLANS, priceLabelFor, trialTermsFor } from '@/lib/billing/plans';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const DISCLOSURE =
  'No real payment is connected to this deployment. Every price below is a ' +
  'test placeholder of $0 and no card can be charged here. When the owner ' +
  'connects a real payment provider, these amounts will be replaced by real ' +
  'ones and this notice will say so.';

/**
 * The honest offer: the plan catalogue with the stub disclosure baked in.
 *
 * Unlike /api/billing — which describes the Stripe-backed world when one is
 * configured — this endpoint describes the beta world: `is_stub: true` on
 * every plan, $0 everywhere, and the plain-language statement that no real
 * payment is connected. The billing UI renders this while the provider is
 * the stub, so the offer a person sees can never drift from what the
 * deployment can actually charge (nothing).
 */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  return Response.json(
    {
      is_stub: true,
      disclosure: DISCLOSURE,
      trial_days_default: 14,
      plans: PLANS.map((plan) => ({
        id: plan.id,
        name: plan.name,
        tagline: plan.tagline,
        tier: plan.tier,
        is_stub: true,
        // The plan's own label, kept for shape — the stub amount is what
        // binds, and it is always zero.
        listed_price_label: priceLabelFor(plan),
        stub_amount_cents: 0,
        stub_amount_label: '$0 (test — no charge)',
        trialDays: plan.trialDays,
        trialTerms: trialTermsFor(plan),
        monthlyTokenCap: plan.monthlyTokenCap,
        features: plan.features,
      })),
    },
    { headers },
  );
}
