'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, LoaderCircle, MailCheck } from 'lucide-react';
import { GoogleButton } from './google-button';
import type { PublicAuthConfig } from '@/lib/auth/public-config';

const auth = createAuthClient();

/** The minimum the server enforces (server/auth.mjs), repeated here so the
 * person is told before submitting rather than after. */
const MIN_PASSWORD = 12;

export function SignUpForm({ config }: { config: PublicAuthConfig }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters. Longer beats complicated.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await auth.signUp.email({ email, password, name: name.trim() || email });
      if (result.error)
        setError(
          result.error.status === 429
            ? 'Too many accounts from here just now. Try again in a little while.'
            : result.error.status === 422 || /exist/i.test(result.error.message ?? '')
              ? 'There is already an account with that address. Sign in instead.'
              : (result.error.message ?? 'Could not create the account. Please try again.'),
        );
      // Where mail is configured the account exists but cannot be used until
      // the address is confirmed, so saying "you are in" would be wrong.
      else if (config.mail) setSent(true);
      else window.location.assign('/chat');
    } catch {
      setError('Your workspace could not be reached. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <p className="auth-sent" role="status">
        <MailCheck size={22} aria-hidden />
        Check <strong>{email}</strong> for a link to confirm the address. You can close this page —
        the link opens your workspace.
      </p>
    );

  return (
    <>
      {config.google && <GoogleButton label="Continue with Google" />}
      <form onSubmit={submit}>
        <label htmlFor="name">Your name</label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={busy}
        />
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={busy}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD}
          disabled={busy}
        />
        <p className="auth-hint">At least {MIN_PASSWORD} characters.</p>
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={18} />
              Creating your workspace…
            </>
          ) : (
            <>
              Create your workspace
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
      <p className="auth-links">
        <span>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </span>
      </p>
    </>
  );
}
