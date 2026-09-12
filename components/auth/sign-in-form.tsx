'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { GoogleButton } from './google-button';
import type { PublicAuthConfig } from '@/lib/auth/public-config';

const auth = createAuthClient();

export function SignInForm({ config }: { config: PublicAuthConfig }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await auth.signIn.email({ email, password });
      if (result.error)
        setError(
          result.error.status === 429
            ? 'Too many attempts. Please wait a minute and try again.'
            : result.error.status === 403
              ? 'Confirm your email address first. Check your inbox for the link.'
              : 'Could not sign in. Check your email and password.',
        );
      else window.location.assign('/');
    } catch {
      setError('Your workspace could not be reached. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {config.google && <GoogleButton label="Continue with Google" />}
      <form onSubmit={submit}>
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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={busy}
        />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={18} />
              Signing in…
            </>
          ) : (
            <>
              Enter your workspace
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
      <p className="auth-links">
        {/* Offered only where the mail that answers it can actually be sent. */}
        {config.mail && <Link href="/forgot-password">Forgot your password?</Link>}
        {config.signUpOpen ? (
          <span>
            New here? <Link href="/sign-up">Create an account</Link>
          </span>
        ) : (
          <span className="auth-note">
            This is a private workspace. Contact the owner for access.
          </span>
        )}
      </p>
    </>
  );
}
