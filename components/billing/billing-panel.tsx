'use client';
/** What you are on, what you have used, and how to change it.
 *
 * Checkout and the portal are the Stripe plugin's own endpoints, so there is no
 * payment code here and no card detail anywhere near this deployment: the
 * buttons redirect to Stripe and Stripe redirects back.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createAuthClient } from 'better-auth/react';
import { stripeClient } from '@better-auth/stripe/client';
import { ArrowLeft, Check, CreditCard, LoaderCircle } from 'lucide-react';
import { clientFetch } from '@/lib/client/request';

const auth = createAuthClient({ plugins: [stripeClient({ subscription: true })] });

type PlanView = {
  id: string;
  name: string;
  tagline: string;
  tier: string;
  trialDays: number;
  /** The trial's terms, stated exactly: what ends, when, what happens after. */
  trialTerms: string;
  priceLabel: string;
  monthlyTokenCap: number | null;
  features: string[];
  purchasable: boolean;
  annual: boolean;
};

type BillingNotice = { kind: string; at: string };

type Billing = {
  tier: 'owner' | 'byok' | 'managed';
  monthlyTokenCap: number | null;
  metered: number;
  usage: { tokens: number; runs: number };
  periodStart: string;
  configured: boolean;
  notices: BillingNotice[];
  plans: PlanView[];
};

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Which failed action the Retry button re-runs: the billing-details fetch, a
 * consent record, a checkout open for a plan, or the billing-portal open. */
type FailedAction =
  | { kind: 'billing' }
  | { kind: 'consent'; plan: string }
  | { kind: 'checkout'; plan: string }
  | { kind: 'portal' };

/** " on 12 March" for the payment-failure notice, or '' when undated. */
function failedNoticeDate(notices: BillingNotice[]): string {
  const at = notices.find((n) => n.kind === 'payment_failed')?.at;
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return ' on ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** The exact terms the consent checkbox agrees to: the trial terms when the
 * plan has a trial, otherwise the price and the cancel policy. */
function consentTerms(plan: PlanView): string {
  if (plan.trialTerms) return plan.trialTerms;
  const price = plan.priceLabel || 'the price shown at checkout';
  return (
    `${plan.name} at ${price}, billed monthly until you cancel. ` +
    'Cancel any time and you land back on Free, keeping every conversation and file.'
  );
}

export function BillingPanel() {
  const [data, setData] = useState<Billing | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  /** The plan whose consent card is open: nothing is charged and no checkout
   * opens until the person ticks the agreement on it. */
  const [consenting, setConsenting] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
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

  /** The meter reads live from the usage ledger on every fetch, but the panel
   * only fetched on mount: a tab left open while runs finished elsewhere
   * showed a stale allowance. Re-read when the tab comes back into view; a
   * failed background refresh never clobbers what is on screen. */
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      void loadBilling()
        .then((payload) => {
          if (payload) setData(payload);
        })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadBilling]);

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
    else if (failedAction.kind === 'consent') {
      const plan = data?.plans.find((p) => p.id === failedAction.plan);
      if (plan) void agreeAndCheckout(plan);
    } else void upgrade(failedAction.plan);
  }

  /** Open the consent card for a plan: the terms first, the checkout only
   * after the person agrees. */
  function startUpgrade(planId: string) {
    setConsenting(planId);
    setAgreed(false);
    setError('');
    setFailedAction(null);
  }

  /** Record the explicit consent, then open Stripe checkout.
   *
   * The consent is what the ticket requires before any charge: it is recorded
   * server-side with the exact terms, and a checkout never opens without it.
   * If recording fails the checkout does not open — nothing was charged.
   */
  async function agreeAndCheckout(plan: PlanView) {
    setBusy(plan.id);
    setError('');
    setFailedAction(null);
    try {
      const r = await clientFetch('/api/billing/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: plan.id }),
      });
      if (!r.ok) throw new Error('consent not recorded');
      await upgrade(plan.id);
    } catch {
      setError(
        'Your agreement could not be recorded, so checkout was not opened. Nothing was charged.',
      );
      setFailedAction({ kind: 'consent', plan: plan.id });
    } finally {
      setBusy('');
    }
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
      <div className="n-error" role="alert" aria-label="Billing unavailable">
        <span className="n-error-icon" aria-hidden="true">
          <CreditCard size={32} />
        </span>
        <h2>Couldn&rsquo;t load billing</h2>
        <p>{error} Nothing was charged — this is just the details not arriving.</p>
        {failedAction && (
          <button type="button" className="n-cta n-press" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    );
  if (!data)
    return (
      <div
        role="status"
        aria-label="Loading your plan"
        style={{ display: 'grid', gap: 12, padding: '8px 0' }}
      >
        <span className="n-shimmer-line" style={{ width: '45%', height: 28 }} aria-hidden="true" />
        <span className="n-shimmer-line" style={{ width: '80%' }} aria-hidden="true" />
        <span
          className="n-shimmer-line"
          style={{ width: '100%', height: 8, borderRadius: 'var(--radius-full)' }}
          aria-hidden="true"
        />
        <span className="n-shimmer-line" style={{ width: '60%' }} aria-hidden="true" />
        <span
          className="n-shimmer-line"
          style={{ width: 160, height: 44, borderRadius: 'var(--radius-full)' }}
          aria-hidden="true"
        />
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
    <div className="billing n-screen-in">
      <header className="n-header">
        <Link href="/chat" className="n-icon-btn n-press" aria-label="Back to your workspace">
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
        <h1>Plan and usage</h1>
        <div className="n-header-actions" aria-hidden="true" />
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
      {data.notices.some((n) => n.kind === 'payment_failed') && data.tier !== 'owner' && (
        <div className="billing-notice" role="status">
          <p>
            <strong>
              Your last payment failed
              {failedNoticeDate(data.notices)}.
            </strong>{' '}
            {data.tier === 'managed'
              ? 'Your Pro access stays on while Stripe retries the card — update your payment method so the retry succeeds.'
              : 'Pro ended because the payment could not be collected. You’re on Free — every conversation and file is intact, and you can re-subscribe any time.'}
          </p>
          {data.tier === 'managed' && (
            <div className="billing-notice-actions">
              <button type="button" onClick={portal} disabled={busy === 'portal'}>
                {busy === 'portal' ? 'Opening…' : 'Update payment method'}
              </button>
            </div>
          )}
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
          <button type="button" className="n-press" onClick={portal} disabled={busy === 'portal'}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </section>

      {error && (
        <div className="billing-inline-error">
          <p role="alert" className="auth-error">
            {error}
          </p>
          {failedAction && (
            <button type="button" className="n-cta n-cta-ghost n-press" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}

      <section className="n-card-grid n-stagger" aria-label="Plans">
        {data.plans.map((plan, i) => {
          const current =
            (plan.tier === 'managed' && data.tier === 'managed') ||
            (plan.tier === 'byok' && data.tier === 'byok');
          return (
            <article
              key={plan.id}
              className={current ? 'billing-plan is-current' : 'billing-plan'}
              style={{ '--i': i } as CSSProperties}
            >
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
              ) : consenting === plan.id ? (
                // Consent before charge: the exact terms first, the checkbox,
                // and only then the checkout. Nothing here charges anything.
                <div className="billing-consent">
                  <p className="billing-terms">{consentTerms(plan)}</p>
                  <label className="billing-agree">
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                    />
                    <span>I agree to be charged exactly as described above.</span>
                  </label>
                  <div className="billing-consent-actions">
                    <button
                      type="button"
                      className="n-press"
                      disabled={!agreed || busy === plan.id}
                      onClick={() => agreeAndCheckout(plan)}
                    >
                      {busy === plan.id ? (
                        <>
                          <LoaderCircle className="spin" size={16} aria-hidden />
                          Recording…
                        </>
                      ) : (
                        'Agree and continue to secure checkout'
                      )}
                    </button>
                    <button
                      type="button"
                      className="n-press n-cta-ghost"
                      onClick={() => setConsenting(null)}
                    >
                      Back
                    </button>
                  </div>
                  <p className="billing-note">
                    Your agreement is recorded with the time and these exact terms. The card itself
                    is handled by Stripe — we never see it.
                  </p>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="n-press"
                    onClick={() => startUpgrade(plan.id)}
                    disabled={busy === plan.id}
                  >
                    {plan.trialDays ? `Start ${plan.trialDays} days free` : `Choose ${plan.name}`}
                  </button>
                  {plan.trialTerms && <p className="billing-terms">{plan.trialTerms}</p>}
                </>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
