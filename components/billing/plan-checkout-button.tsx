'use client';
/** One plan's call to action on the public pricing page.
 *
 * Signed in: opens the Stripe checkout the billing page uses — the same
 * plugin, the same plans, so the price quoted is the price charged. Stripe
 * returns to /billing?upgraded=1, where the panel confirms the plan is live.
 * Signed out: the account comes first, because checkout bills a person.
 */
import { useState } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { stripeClient } from '@better-auth/stripe/client';
import { LoaderCircle } from 'lucide-react';

const auth = createAuthClient({ plugins: [stripeClient({ subscription: true })] });

export function PlanCheckoutButton({
  planId,
  label,
  signedIn,
  signUpOpen,
}: {
  planId: string;
  label: string;
  signedIn: boolean;
  signUpOpen: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!signedIn)
    return (
      <Link href={signUpOpen ? '/sign-up' : '/sign-in'} className="landing-primary">
        {label}
      </Link>
    );

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      // A success leaves this page, so reaching the next line with an error
      // is the only outcome there is anything to say about.
      const result = await auth.subscription.upgrade({
        plan: planId,
        successUrl: '/billing?upgraded=1',
        cancelUrl: '/pricing',
      });
      if (result?.error) setError(result.error.message ?? 'Checkout could not be opened.');
    } catch {
      setError('Checkout could not be opened. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={checkout} disabled={busy} className="landing-primary">
        {busy ? (
          <>
            <LoaderCircle className="spin" size={16} aria-hidden />
            Opening checkout…
          </>
        ) : (
          label
        )}
      </button>
      {error && (
        <p role="alert" className="landing-price-tbd">
          {error}
        </p>
      )}
    </>
  );
}
