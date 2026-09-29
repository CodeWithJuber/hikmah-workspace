'use client';
/** What you are on, what you have used, and how to change it.
 *
 * Checkout and the portal are the Stripe plugin's own endpoints, so there is no
 * payment code here and no card detail anywhere near this deployment: the
 * buttons redirect to Stripe and Stripe redirects back.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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

/** Which failed action the Retry button re-runs: the billing-details fetch, a
 * checkout open for a plan, or the billing-portal open. */
type FailedAction = { kind: 'billing' } | { kind: 'checkout'; plan: string } | { kind: 'portal' };

export function BillingPanel() {
  const [data, setData] = useState<Billing | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  /** ?upgraded=1 is Stripe's return leg: it resolves once, then the URL is
   * cleaned so a reload or a shared link never re-announces it. */
  const [justUpgraded, setJustUpgraded] = useState(searchParams.get('upgraded') === '1');

  /** The billing-details fetch, shared by the mount effect and the Retry
   * button. Returns the payload instead of setting state: the React Compiler
   * lint treats a component-scope function containing setState as a
   * synchronous setState when an effect calls it, so the effect below wires
   * the promise with inline callbacks, the way the old `.then` chain did. */
  const loadBilling = useCallback(async (): Promise<Billing | null> => {
    const r = await clientFetch('/api/billing', {});
    const payload = r.ok ? await r.json() : null;
    return (payload as Billing) ?? null;
  }, []);

  /** A billing fetch that failed or came back empty: the honest error plus
   * the action the Retry button re-runs. */
  function failBillingLoad() {
    setError('Your billing details could not be loaded.');
    setFailedAction({ kind: 'billing' });
  }

  useEffect(() => {
    let live = true;
    void loadBilling()
      .then((payload) => {
        if (!live) return;
        if (payload) {
          setData(payload);
          // The ?upgraded=1 return leg means nothing for the operator tier —
          // there is nothing to buy — so the URL is cleaned without fanfare.
          if (searchParams.get('upgraded') === '1' && payload.tier === 'owner')
            router.replace('/billing', { scroll: false });
        } else failBillingLoad();
      })
      .catch(() => {
        if (live) failBillingLoad();
      });
    return () => {
      live = false;
    };
  }, [loadBilling, router, searchParams]);

  /** Re-run whichever action failed last. Clears the error first so the panel
   * shows its loading state, never a dead Retry button. */
  function retry() {
    if (!failedAction) return;
    setError('');
    setFailedAction(null);
    if (failedAction.kind === 'billing')
      void loadBilling()
        .then((payload) => {
          if (payload) setData(payload);
          else failBillingLoad();
        })
        .catch(failBillingLoad);
    else if (failedAction.kind === 'portal') void portal();
    else void upgrade(failedAction.plan);
  }

  async function upgrade(plan: string) {
    setBusy(plan);
    setError('');
    setFailedAction(null);
    try {
      // A success redirects away from this page, so reaching the next line with
      // an error is the only outcome there is anything to say about.
      const result = await auth.subscription.upgrade({
        plan,
        successUrl: '/billing?upgraded=1',
        cancelUrl: '/billing',
      });
      if (result?.error) {
        setError(result.error.message ?? 'Checkout could not be opened.');
        setFailedAction({ kind: 'checkout', plan });
      }
    } catch {
      setError('Checkout could not be opened. Try again in a moment.');
      setFailedAction({ kind: 'checkout', plan });
    } finally {
      setBusy('');
    }
  }

  async function portal() {
    setBusy('portal');
    setError('');
    setFailedAction(null);
    try {
      const result = await auth.subscription.billingPortal({ returnUrl: '/billing' });
      if (result?.error) {
        setError(result.error.message ?? 'The billing portal could not be opened.');
        setFailedAction({ kind: 'portal' });
      }
    } catch {
      setError('The billing portal could not be opened. Try again in a moment.');
      setFailedAction({ kind: 'portal' });
    } finally {
      setBusy('');
    }
  }

  if (error && !data)
    return (
      <section className="billing-current" aria-label="Billing unavailable">
        <p role="alert" className="auth-error">
          {error}
        </p>
        {failedAction && (
          <button type="button" onClick={retry}>
            Retry
          </button>
        )}
      </section>
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
  const period = new Date(data.periodStart);
  const resetsOn = new Date(period.getFullYear(), period.getMonth() + 1, 1).toLocaleDateString(
    undefined,
    { day: 'numeric', month: 'long' },
  );

  /** The ?upgraded=1 param is answered once; the URL is cleaned so a reload or
   * a shared link never re-announces it. */
  function dismissUpgradeNotice() {
    setJustUpgraded(false);
    router.replace('/billing', { scroll: false });
  }

  return (
    <div className="billing">
      <header className="billing-head">
        <Link href="/chat" className="billing-back">
          <ArrowLeft size={16} aria-hidden />
          Back to your workspace
        </Link>
        <h1>Plan and usage</h1>
      </header>

      {justUpgraded && data.tier === 'managed' && (
        <div className="billing-notice" role="status">
          <p>
            <strong>Your Pro plan is active.</strong>
            Five million included tokens a month, fast models, no key to manage — and you can still
            use your own key any time. Manage the plan from this page.
          </p>
          <div className="billing-notice-actions">
            <button type="button" onClick={dismissUpgradeNotice}>
              Got it
            </button>
          </div>
        </div>
      )}
      {justUpgraded && data.tier === 'byok' && (
        <div className="billing-notice" role="status">
          <p>
            <strong>Payment received — your plan is activating.</strong>
            The confirmation usually lands in under a minute. If this page still shows Free, wait a
            moment and retry.
          </p>
          <div className="billing-notice-actions">
            <button
              type="button"
              onClick={() => {
                void loadBilling().then((payload) => {
                  if (payload) setData(payload);
                });
              }}
            >
              Retry
            </button>
            <button type="button" onClick={dismissUpgradeNotice}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {data.tier === 'managed' && cap !== null && percent >= 80 && (
        <div className={'billing-notice' + (percent >= 100 ? ' is-critical' : '')} role="status">
          <p>
            <strong>
              {percent >= 100
                ? 'This month’s included tokens are used up.'
                : `You’ve used ${percent}% of this month’s included tokens.`}
            </strong>
            They reset on {resetsOn}. Runs on your own key never count against the allowance.
          </p>
          <div className="billing-notice-actions">
            <Link href="/pricing?plan=pro">See plans</Link>
          </div>
        </div>
      )}

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
        <div>
          <p role="alert" className="auth-error">
            {error}
          </p>
          {failedAction && (
            <button type="button" className="text-link" onClick={retry}>
              Retry
            </button>
          )}
        </div>
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
                // been given no Stripe credentials. Point at the plans page so
                // the person can see what Pro will be, and say what works now.
                <p className="billing-note">
                  Payments are not set up on this deployment yet — see{' '}
                  <Link href="/pricing">pricing</Link> for what Pro will offer. The Free plan with
                  your own key works today.
                </p>
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
