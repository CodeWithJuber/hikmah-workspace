'use client';
import Link from 'next/link';
import { useState } from 'react';
import { createAuthClient } from 'better-auth/react';
const auth = createAuthClient();
export default function SignOut() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Sign out of Hikmah?</h1>
        <p className="auth-subtitle">Your saved workspace will be here when you return.</p>
        {error && <p role="alert">{error}</p>}
        <button
          className="auth-submit"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const r = await auth.signOut();
              if (r.error) throw Error();
              window.location.assign('/sign-in');
            } catch {
              setError('Could not sign out. Please retry.');
              setBusy(false);
            }
          }}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
        <Link href="/" className="auth-back">
          Back to workspace
        </Link>
      </section>
    </main>
  );
}
