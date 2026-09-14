import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { publicAuthConfig } from '@/lib/auth/public-config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Create an account · Hikmah',
  description: 'Create a Hikmah workspace. Free with your own model key.',
};

export default function SignUp() {
  const config = publicAuthConfig();
  // A private deployment has no sign-up page at all, rather than one that
  // renders a form the server will refuse.
  if (!config.signUpOpen) redirect('/sign-in');
  return (
    <AuthShell
      eyebrow="START FREE"
      title="Make a workspace."
      subtitle={
        <>
          Bring your own model key and pay nothing.
          <br />
          Upgrade later if you would rather we supplied them.
        </>
      }
    >
      <SignUpForm config={config} />
    </AuthShell>
  );
}
