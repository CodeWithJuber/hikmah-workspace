import { z } from 'zod';
import { createRequire } from 'node:module';
import { audit, authDatabase, requirePermission, targetAccount } from '@/lib/authz/server';
import { billingConfigured } from '@/lib/billing/plans';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const bodySchema = z.object({ userId: z.string().min(1).max(128) });

/** Refund the account's most recent paid invoice through Stripe.
 *
 * The operator picks the account; the route picks the payment — refunding
 * "the latest charge" is the manual-refund case (a mistaken charge, a
 * goodwill gesture), and naming the payment intent by hand would be a second
 * tool for the same job. The Stripe plugin owns the subscription rows, so the
 * customer id is read from its table; anything unexpected there is an honest
 * 400 rather than a 500, because this route must never look like it worked
 * when it did not touch money.
 *
 * The tier is left alone on purpose: a refunded customer whose subscription
 * is still active in Stripe would be re-granted by the next webhook. Revoking
 * access is the tier override's job, one button away in the console, and the
 * audit log ties the two rows together by account. */
export async function POST(request: Request) {
  let grant;
  try {
    grant = await requirePermission('billing:override');
  } catch (error) {
    const status = error instanceof KernelHttpError ? error.status : 403;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Not allowed.' },
      { status, headers },
    );
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: 'Unknown account.' }, { status: 400, headers });
  let target;
  try {
    target = await targetAccount(parsed.data.userId);
  } catch (error) {
    const status = error instanceof KernelHttpError ? error.status : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown account.' },
      { status, headers },
    );
  }
  if (!billingConfigured() || !process.env.STRIPE_SECRET_KEY)
    return Response.json(
      {
        error: 'This deployment has no Stripe credentials, so there is nothing to refund through.',
      },
      { status: 400, headers },
    );

  // The plugin bills against referenceId, which defaults to the user id for a
  // personal subscription (see server/billing-sync.mjs).
  let stripeCustomerId = '';
  try {
    const row = authDatabase()
      .prepare('SELECT stripeCustomerId FROM subscription WHERE referenceId = ? LIMIT 1')
      .get(target.id) as { stripeCustomerId?: string } | undefined;
    stripeCustomerId = row?.stripeCustomerId ?? '';
  } catch {
    return Response.json(
      { error: 'No Stripe subscription is recorded for this account.' },
      { status: 400, headers },
    );
  }
  if (!stripeCustomerId)
    return Response.json(
      { error: 'No Stripe customer is recorded for this account.' },
      { status: 400, headers },
    );

  try {
    const require_ = createRequire(import.meta.url);
    const Stripe = require_('stripe').default ?? require_('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const invoices = await stripe.invoices.list({ customer: stripeCustomerId, limit: 10 });
    const paid = invoices.data.find((invoice: { status?: string }) => invoice.status === 'paid');
    // The charge to reverse: the invoice's payment intent when Stripe names
    // one. An invoice with no payment intent has no card charge to reverse.
    const intentId =
      (typeof paid?.payment_intent === 'string' && paid.payment_intent) ||
      (paid?.payment_intent as { id?: string } | undefined)?.id ||
      '';
    if (!paid || !intentId)
      return Response.json(
        { error: 'This account has no paid invoice to refund.' },
        { status: 400, headers },
      );
    const refund = await stripe.refunds.create({ payment_intent: intentId });
    const amount = typeof paid.amount_paid === 'number' ? paid.amount_paid : 0;
    const currency = typeof paid.currency === 'string' ? paid.currency.toUpperCase() : '';
    audit(
      grant.user.userId,
      'billing.refund',
      target.id,
      `refunded ${amount} ${currency} (invoice ${paid.id}, refund ${refund.id})`,
    );
    return Response.json(
      { ok: true, refundId: refund.id, amount, currency, invoiceId: paid.id },
      { headers },
    );
  } catch (error) {
    // Stripe's own message is safe to show: it names the failure, not a key.
    return Response.json(
      { error: error instanceof Error ? error.message : 'The refund could not be made.' },
      { status: 502, headers },
    );
  }
}
