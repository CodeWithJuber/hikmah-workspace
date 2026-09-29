import { randomUUID } from 'node:crypto';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { billingStore } from '@/lib/billing/server';
import {
  planById,
  priceIdFor,
  priceLabelFor,
  trialTermsFor,
  billingConfigured,
} from '@/lib/billing/plans';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/**
 * Record the explicit consent to be charged, before any checkout opens.
 *
 * The UI shows the exact terms (the trial terms when the plan has a trial,
 * otherwise the plan's price note) and only calls here after the person ticks
 * the agreement. The row keeps the terms text itself, so what was consented to
 * is auditable without reconstructing it from a later plan catalogue.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  let planId = '';
  try {
    planId = String((await request.json())?.planId ?? '');
  } catch {
    return Response.json({ error: 'The request was not valid JSON.' }, { status: 400, headers });
  }
  const plan = planById(planId);
  if (!plan || !billingConfigured() || !priceIdFor(plan))
    return Response.json(
      { error: 'That plan cannot be bought on this deployment.' },
      { status: 400, headers },
    );

  const terms = trialTermsFor(plan) || plan.priceNote || '';
  const priceLabel = priceLabelFor(plan);
  const agreedAt = new Date().toISOString();
  billingStore().recordConsent({
    id: 'con_' + randomUUID(),
    userId: user.userId,
    planId: plan.id,
    priceLabel,
    terms,
  });
  return Response.json({ ok: true, planId: plan.id, priceLabel, terms, agreedAt }, { headers });
}
