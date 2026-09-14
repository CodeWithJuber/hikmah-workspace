import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignInForm } from '@/components/auth/sign-in-form';
import { publicAuthConfig } from '@/lib/auth/public-config';

// A server component so the page offers only what this deployment is actually
// configured for: no Google button without credentials, no reset link without
// a mail provider, no "create an account" on a private install.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Sign in · Hikmah',
  description: 'Sign in to your Hikmah workspace.',
};

export default function SignIn() {
  return (
    <AuthShell
      eyebrow="YOUR SPACE TO THINK & CREATE"
      title="Good to have you here."
      subtitle={
        <>
          Your conversations, tools and knowledge.
          <br />
          Together in one workspace.
        </>
      }
    >
      <SignInForm config={publicAuthConfig()} />
    </AuthShell>
  );
}
