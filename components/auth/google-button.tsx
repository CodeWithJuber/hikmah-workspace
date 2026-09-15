'use client';
import { createAuthClient } from 'better-auth/react';
import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

const auth = createAuthClient();

/** Sign in with Google.
 *
 * Rendered only where the deployment has credentials, so this component never
 * has to explain that the button does not work. `callbackURL` is where Google
 * returns to; the same landing as the password form, so the two paths agree.
 */
export function GoogleButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className="auth-social"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void auth.signIn.social({ provider: 'google', callbackURL: '/chat' });
        }}
      >
        {busy ? (
          <LoaderCircle className="spin" size={20} aria-hidden />
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
            <path
              fill="#4285F4"
              d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9Z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8H1.4v3.1A12 12 0 0 0 12 24Z"
            />
            <path
              fill="#FBBC05"
              d="M5.4 14.3a7.1 7.1 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l4-3.1Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.4 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8Z"
            />
          </svg>
        )}
        {label}
      </button>
      <p className="auth-divider">
        <span>or</span>
      </p>
    </>
  );
}
