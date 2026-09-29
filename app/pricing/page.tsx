import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { getChatGPTUser } from '../chatgpt-auth';
import { PLANS, billingConfigured, priceIdFor, priceLabelFor } from '@/lib/billing/plans';
import { publicAuthConfig } from '@/lib/auth/public-config';
import { PlanCheckoutButton } from '@/components/billing/plan-checkout-button';
import { HikmahIcon } from '@/components/kernel/icons';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plans and pricing · Hikmah',
  description:
    'Two ways to pay for the models: bring your own key for free, or Pro with 14 days free and 5 million tokens a month.',
};

/** The shareable pricing page: the upgrade destination.
 *
 * Public — no sign-in — so a link to it works anywhere: the in-chat upgrade
 * prompt, the billing page, a message to a friend. The cards read the same
 * catalogue (`server/plans.mjs`) the checkout and the entitlement check read,
 * so this page cannot advertise something the app will not honour.
 *
 * Deep-linkable: `?plan=pro` highlights the Pro card, which is where the
 * in-chat "near your limit" prompt points. */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan: highlight } = await searchParams;
  const config = publicAuthConfig();
  const user = await getChatGPTUser();
  const start = config.signUpOpen ? '/sign-up' : '/sign-in';

  return (
    <div className="landing">
      <section className="landing-hero">
        <p className="landing-eyebrow">
          <HikmahIcon name="orbit" size={20} />
          Hikmah
        </p>
        <h1>Two ways to pay for the models.</h1>
        <p className="landing-lede">
          The workspace is the same on both. The only question is whose key the models run on.
        </p>
        <div className="landing-cta">
          {user ? (
            <Link href="/chat" className="landing-primary">
              Back to your workspace
            </Link>
          ) : (
            <Link href={start} className="landing-primary">
              {config.signUpOpen ? 'Start free' : 'Sign in'}
            </Link>
          )}
        </div>
      </section>

      <section className="landing-pricing" aria-label="Plans">
        <div className="landing-plans">
          {PLANS.map((plan) => {
            const cta =
              plan.tier === 'managed' ? (
                !billingConfigured() ? (
                  <p className="landing-price-tbd">
                    Payments are not set up on this deployment yet.
                  </p>
                ) : !priceIdFor(plan) ? (
                  <p className="landing-price-tbd">This plan has no price configured yet.</p>
                ) : (
                  <PlanCheckoutButton
                    planId={plan.id}
                    label={
                      plan.trialDays ? `Start ${plan.trialDays} days free` : `Choose ${plan.name}`
                    }
                    signedIn={Boolean(user)}
                    signUpOpen={config.signUpOpen}
                  />
                )
              ) : (
                <Link href={start}>Start free</Link>
              );
            return (
              <article
                key={plan.id}
                className={
                  (plan.tier === 'managed' ? 'is-featured' : '') +
                  (highlight === plan.id ? ' is-highlighted' : '')
                }
              >
                <h3>{plan.name}</h3>
                <p className="landing-price">
                  {priceLabelFor(plan) || (
                    <span className="landing-price-tbd">Price at checkout</span>
                  )}
                </p>
                {plan.priceNote && <p className="landing-pricenote">{plan.priceNote}</p>}
                <p className="landing-tagline">{plan.tagline}</p>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={16} aria-hidden />
                      {feature}
                    </li>
                  ))}
                </ul>
                {cta}
              </article>
            );
          })}
        </div>
        {!billingConfigured() && (
          <p className="landing-fineprint">
            This deployment is not taking payments yet — Pro checkout appears once its operator
            connects Stripe.
          </p>
        )}
      </section>

      <section className="landing-faq" aria-label="About billing">
        <h2>How billing works.</h2>
        <dl>
          <div>
            <dt>What happens after the 14 free days?</dt>
            <dd>
              Stripe bills the card you put down at checkout, monthly. Cancel any time from the
              billing page and you land back on Free, keeping every conversation and file.
            </dd>
          </div>
          <div>
            <dt>What counts against the 5 million tokens?</dt>
            <dd>
              Only runs on our key. A turn on your own key is recorded so you can see it, never
              rationed — it costs us nothing.
            </dd>
          </div>
          <div>
            <dt>Can I switch back and forth?</dt>
            <dd>
              Yes. Free means your own key, any time, no card. Pro means no key to manage. The
              workspace does not care which you are on.
            </dd>
          </div>
        </dl>
      </section>

      <footer className="landing-foot">
        <span className="landing-logo">
          <HikmahIcon name="orbit" size={20} />
          Hikmah
        </span>
        <nav>
          {user && <Link href="/chat">Your workspace</Link>}
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}
