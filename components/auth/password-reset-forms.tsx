'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, LoaderCircle, MailCheck } from 'lucide-react';

const auth = createAuthClient();
const MIN_PASSWORD = 12;

/** Ask for a reset link.
 *
 * The answer is the same whether or not the address has an account: telling a
 * stranger which addresses are registered is a slow way of leaking the customer
 * list, and it buys the person nothing.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await auth.requestPasswordReset({ email, redirectTo: '/reset-password' });
    } catch {
      /* Reported the same way either way, deliberately. */
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  if (sent)
    return (
      <p className="auth-sent" role="status">
        <MailCheck size={22} aria-hidden />
        If there is an account for <strong>{email}</strong>, a link to set a new password is on its
        way. It can be used once, and expires shortly.
      </p>
    );

  return (
    <>
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
        <button type="submit" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={18} />
              Sending…
            </>
          ) : (
            <>
              Send the link
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </>
  );
}

/** Set the new password, using the token from the emailed link. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token)
    return (
      <p role="alert" className="auth-error">
        That link is missing its token. Ask for a new one from{' '}
        <Link href="/forgot-password">the reset page</Link>.
      </p>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await auth.resetPassword({ newPassword: password, token });
      if (result.error)
        setError(
          'That link has expired or has already been used. Ask for a new one and try again.',
        );
      else window.location.assign('/sign-in');
    } catch {
      setError('Your workspace could not be reached. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={submit}>
        <label htmlFor="password">New password</label>
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
              Saving…
            </>
          ) : (
            <>
              Set the password
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </>
  );
}
