import { z } from 'zod';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { billingStore } from '@/lib/billing/server';
import { betaStore } from '@/lib/billing/beta-server';
import {
  cancelStubSubscription,
  convertTrial,
  renewStubSubscription,
  subscriptionEffectiveEnd,
  trialState,
  type CancelMode,
} from '@/lib/billing/beta';
import { paymentProvider } from '@/lib/billing/provider-stub';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const actionSchema = z.discriminatedUnion('action', [
  // The person ticks "yes, start the paid plan (test, $0)" themselves; the
  // route refuses without that tick. Nothing here auto-converts.
  z.object({
    action: z.literal('confirm'),
    trialId: z.string().min(1),
    confirmed: z.literal(true),
  }),
  z.object({
    action: z.literal('cancel'),
    subscriptionId: z.string().min(1),
    mode: z.enum(['immediate', 'at_period_end']),
  }),
  z.object({ action: z.literal('renew'), subscriptionId: z.string().min(1) }),
]);

/**
 * The stub subscription lifecycle.
 *
 * GET: the person's latest stub subscription, if any. POST: one of
 * confirm / cancel / renew. Every one of them goes through the stub
 * provider, whose receipts say $0 and "no charge", because no real payment
 * provider is connected to this deployment.
 */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  const sub = betaStore().latestSubscriptionFor(user.userId);
  if (!sub) return Response.json({ subscription: null, is_stub: true }, { headers });
  return Response.json(
    {
      subscription: { ...sub, effective_end: subscriptionEffectiveEnd(sub) },
      is_stub: true,
    },
    { headers },
  );
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  let parsed: z.infer<typeof actionSchema>;
  try {
    parsed = actionSchema.parse(await request.json());
  } catch {
    return Response.json(
      { error: 'The request needs a valid action: confirm, cancel or renew.' },
      { status: 400, headers },
    );
  }

  const store = betaStore();
  const provider = paymentProvider();

  if (parsed.action === 'confirm') {
    const trial = store.trialById(parsed.trialId);
    if (!trial || trial.user_id !== user.userId)
      return Response.json({ error: 'No such trial.' }, { status: 404, headers });
    if (trialState(trial) !== 'active')
      return Response.json(
        { error: 'Only an active trial can convert. This one is already over.' },
        { status: 400, headers },
      );

    const converted = convertTrial(trial, { confirmed: parsed.confirmed });
    if ('error' in converted)
      return Response.json(
        { error: 'Conversion needs your explicit confirmation.' },
        { status: 400, headers },
      );

    // The provider call is where money would move with a real provider. The
    // stub logs "STUB: no charge" and returns a $0 test receipt instead.
    const receipt = await provider.createSubscription({
      userId: user.userId,
      planId: trial.plan_id,
      confirmed: true,
    });
    const subscription = { ...converted.subscription, last_receipt: receipt.receipt_id };
    store.createSubscription(subscription);
    store.markConverted(trial.id, subscription.id);
    billingStore().setTier(user.userId, 'managed');
    return Response.json(
      {
        subscription: { ...subscription, effective_end: subscriptionEffectiveEnd(subscription) },
        receipt,
        is_stub: true,
        note: 'Converted on your confirmation. Test subscription: $0, no charge, no card on file.',
      },
      { headers },
    );
  }

  const sub = store.subscriptionById(parsed.subscriptionId);
  if (!sub || sub.user_id !== user.userId)
    return Response.json({ error: 'No such subscription.' }, { status: 404, headers });

  if (parsed.action === 'cancel') {
    const mode: CancelMode = parsed.mode;
    const canceled = cancelStubSubscription(sub, { mode });
    if ('error' in canceled)
      return Response.json(
        { error: 'That subscription is already canceled.' },
        { status: 400, headers },
      );

    const receipt = await provider.cancelSubscription({
      userId: user.userId,
      subscriptionId: sub.id,
      mode,
    });
    const next = { ...canceled.subscription, last_receipt: receipt.receipt_id };
    store.saveSubscription(next);
    if (mode === 'immediate') billingStore().setTier(user.userId, 'byok');
    return Response.json(
      {
        subscription: { ...next, effective_end: subscriptionEffectiveEnd(next) },
        receipt,
        is_stub: true,
        note:
          mode === 'immediate'
            ? 'Canceled immediately. You are back on the free tier.'
            : 'Will cancel at the end of the period. Nothing is charged either way — this is a stub.',
      },
      { headers },
    );
  }

  // renew
  const receipt = await provider.renewSubscription({ userId: user.userId, subscriptionId: sub.id });
  const renewed = renewStubSubscription(sub, { receipt: receipt.receipt_id });
  if ('error' in renewed)
    return Response.json(
      { error: 'Only an active subscription can renew.' },
      { status: 400, headers },
    );
  store.saveSubscription(renewed.subscription);
  return Response.json(
    {
      subscription: {
        ...renewed.subscription,
        effective_end: subscriptionEffectiveEnd(renewed.subscription),
      },
      receipt,
      is_stub: true,
      note: 'Stub renewal: the period rolled forward 30 days at $0. No charge.',
    },
    { headers },
  );
}
