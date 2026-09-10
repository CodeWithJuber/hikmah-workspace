'use client';
import { useState, type FormEvent } from 'react';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { HikmahIcon } from '@/components/kernel/icons';
import { APP_RELEASE, BUILD_ID } from '@/lib/release';
const auth = createAuthClient();
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await auth.signIn.email({ email, password });
      if (result.error) setError(result.error.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : 'Could not sign in. Check your email and password.');
      else window.location.assign('/');
    } catch { setError('Your workspace could not be reached. Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><HikmahIcon name="orbit" size={38}/><span>Hikmah</span></div><p className="auth-eyebrow">YOUR SPACE TO THINK & CREATE</p><h1>Good to have you here.</h1><p className="auth-subtitle">Your conversations, tools and knowledge.<br/>Together in one workspace.</p><form onSubmit={submit}><label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required disabled={busy}/><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required disabled={busy}/>{error&&<p role="alert" className="auth-error">{error}</p>}<button type="submit" disabled={busy}>{busy?<><LoaderCircle className="spin" size={18}/>Signing in…</>:<>Enter your workspace<ArrowRight size={18}/></>}</button></form><p className="auth-note">This is a private workspace. Contact the owner for access.</p><footer>App v{APP_RELEASE} <span>Build {BUILD_ID.slice(0,7)}</span></footer></section></main>;
}
