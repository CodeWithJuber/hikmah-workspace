'use client';
/** What you are on, what you have used, and how to change it.
 *
 * Checkout and the portal are the Stripe plugin's own endpoints, so there is no
 * payment code here and no card detail anywhere near this deployment: the
 * buttons redirect to Stripe and Stripe redirects back.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { stripeClient } from '@better-auth/stripe/client';
import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';

const auth = createAuthClient({ plugins: [stripeClient({ subscription: true })] });

type PlanView = {
  id: string;
  name: string;
  tagline: string;
  tier: string;
  trialDays: number;
  monthlyTokenCap: number | null;
  features: string[];
  purchasable: boolean;
  annual: boolean;
};

type Billing = {
  tier: 'owner' | 'byok' | 'managed';
  monthlyTokenCap: number | null;
  metered: number;
  usage: { tokens: number; runs: number };
  periodStart: string;
  configured: boolean;
  plans: PlanView[];
};

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function BillingPanel() {
  const [data, setData] = useState<Billing | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void clientFetch('/api/billing', {})
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (live && payload) setData(payload as Billing);
      })
      .catch(() => setError('Your billing details could not be loaded. Reload to try again.'));
    return () => {
      live = false;
    };
  }, []);

  async function upgrade(plan: string) {
    setBusy(plan);
    setError('');
    try {
      // A success redirects away from this page, so reaching the next line with
      // an error is the only outcome there is anything to say about.
      const result = await auth.subscription.upgrade({
        plan,
        successUrl: '/billing',
        cancelUrl: '/billing',
      });
      if (result?.error) setError(result.error.message ?? 'Checkout could not be opened.');
    } catch {
      setError('Checkout could not be opened. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  async function portal() {
    setBusy('portal');
    setError('');
    try {
      const result = await auth.subscription.billingPortal({ returnUrl: '/billing' });
      if (result?.error)
        setError(result.error.message ?? 'The billing portal could not be opened.');
    } catch {
      setError('The billing portal could not be opened. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  if (error && !data)
    return (
      <p role="alert" className="auth-error">
        {error}
      </p>
    );
  if (!data)
    return (
      <div className="billing-loading grid gap-3" role="status" aria-label="Loading your plan">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-10 w-40" />
      </div>
    );

  const cap = data.monthlyTokenCap;
  const used = cap === null ? data.usage.tokens : data.metered;
  const percent = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const since = new Date(data.periodStart).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="billing">
      <header className="billing-head">
        <Link href="/chat" className="billing-back">
          <ArrowLeft size={16} aria-hidden />
          Back to your workspace
        </Link>
        <h1>Plan and usage</h1>
      </header>

      <section className="billing-current">
        <p className="billing-eyebrow">CURRENT PLAN</p>
        <h2>
          {data.tier === 'owner'
            ? 'Operator'
            : data.tier === 'managed'
              ? 'Pro'
              : 'Free — your own key'}
        </h2>
        <p className="billing-usage-line">
          {compact.format(data.usage.tokens)} tokens across {data.usage.runs}{' '}
          {data.usage.runs === 1 ? 'answer' : 'answers'} since {since}.
        </p>
        {cap !== null ? (
          <>
            <div
              className="billing-meter"
              role="meter"
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={cap}
              aria-label="Included tokens used this month"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <p className="billing-usage-line">
              {compact.format(used)} of {compact.format(cap)} included tokens used.
            </p>
          </>
        ) : (
          <p className="billing-usage-line">
            {data.tier === 'owner'
              ? 'No limit: this is the deployment you operate.'
              : 'No limit from us — your own provider bills you for what you use.'}
          </p>
        )}
        {data.tier === 'managed' && (
          <button type="button" onClick={portal} disabled={busy === 'portal'}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </section>

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}

      <section className="billing-plans">
        {data.plans.map((plan) => {
          const current =
            (plan.tier === 'managed' && data.tier === 'managed') ||
            (plan.tier === 'byok' && data.tier === 'byok');
          return (
            <article key={plan.id} className={current ? 'billing-plan is-current' : 'billing-plan'}>
              <h3>{plan.name}</h3>
              <p className="billing-tagline">{plan.tagline}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
              {current ? (
                <p className="billing-note">Your current plan.</p>
              ) : plan.tier === 'byok' ? (
                <p className="billing-note">
                  Cancel Pro and you land here, keeping every conversation and file.
                </p>
              ) : !data.configured ? (
                // Honest rather than a button that fails: this deployment has
                // been given no Stripe credentials.
                <p className="billing-note">Payments are not set up on this deployment yet.</p>
              ) : !plan.purchasable ? (
                <p className="billing-note">This plan has no price configured yet.</p>
              ) : (
                <button type="button" onClick={() => upgrade(plan.id)} disabled={busy === plan.id}>
                  {busy === plan.id ? (
                    <>
                      <LoaderCircle className="spin" size={16} aria-hidden />
                      Opening checkout…
                    </>
                  ) : plan.trialDays ? (
                    `Start ${plan.trialDays} days free`
                  ) : (
                    `Choose ${plan.name}`
                  )}
                </button>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
