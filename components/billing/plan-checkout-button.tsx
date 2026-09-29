'use client';
/** One plan's call to action on the public pricing page.
 *
 * Signed in: the consent card first — the exact trial terms and a checkbox —
 * and only then the Stripe checkout the billing page uses. The consent is
 * recorded server-side before the checkout opens: no charge without it.
 * Signed out: the account comes first, because checkout bills a person.
 */
import { useState } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { stripeClient } from '@better-auth/stripe/client';
import { LoaderCircle } from 'lucide-react';
import { clientFetch } from '@/lib/client/request';

const auth = createAuthClient({ plugins: [stripeClient({ subscription: true })] });

export function PlanCheckoutButton({
  planId,
  planName,
  label,
  signedIn,
  signUpOpen,
  trialTerms,
  priceLabel,
}: {
  planId: string;
  planName: string;
  label: string;
  signedIn: boolean;
  signUpOpen: boolean;
  trialTerms: string;
  priceLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consenting, setConsenting] = useState(false);
  const [agreed, setAgreed] = useState(false);

  /** The exact terms the checkbox agrees to. */
  const terms =
    trialTerms ||
    `${planName} at ${priceLabel || 'the price shown at checkout'}, billed monthly until you cancel. ` +
      'Cancel any time and you land back on Free, keeping every conversation and file.';

  if (!signedIn)
    return (
      <Link href={signUpOpen ? '/sign-up' : '/sign-in'} className="landing-primary">
        {label}
      </Link>
    );

  async function agreeAndCheckout() {
    setBusy(true);
    setError('');
    try {
      // The consent is recorded first: a checkout never opens without it.
      const r = await clientFetch('/api/billing/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      if (!r.ok) throw new Error('consent not recorded');
      // A success leaves this page, so reaching the next line with an error
      // is the only outcome there is anything to say about.
      const result = await auth.subscription.upgrade({
        plan: planId,
        successUrl: '/billing?upgraded=1',
        cancelUrl: '/pricing',
      });
      if (result?.error) setError(result.error.message ?? 'Checkout could not be opened.');
    } catch {
      setError(
        'Your agreement could not be recorded, so checkout was not opened. Nothing was charged.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (consenting)
    return (
      <div className="landing-consent">
        <p className="landing-terms">{terms}</p>
        <label className="landing-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I agree to be charged exactly as described above.</span>
        </label>
        <div className="landing-consent-actions">
          <button
            type="button"
            onClick={agreeAndCheckout}
            disabled={!agreed || busy}
            className="landing-primary"
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} aria-hidden />
                Recording…
              </>
            ) : (
              'Agree and continue to secure checkout'
            )}
          </button>
          <button type="button" onClick={() => setConsenting(false)} className="landing-secondary">
            Back
          </button>
        </div>
        <p className="landing-fineprint">
          Your agreement is recorded with the time and these exact terms. The card itself is handled
          by Stripe — we never see it.
        </p>
        {error && (
          <p role="alert" className="landing-price-tbd">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setConsenting(true);
          setAgreed(false);
          setError('');
        }}
        className="landing-primary"
      >
        {label}
      </button>
      {error && (
        <p role="alert" className="landing-price-tbd">
          {error}
        </p>
      )}
    </>
  );
}
