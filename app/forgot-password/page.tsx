import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth/auth-shell';
import { ForgotPasswordForm } from '@/components/auth/password-reset-forms';
import { publicAuthConfig } from '@/lib/auth/public-config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Reset your password · Hikmah',
  description: 'Ask for a link to set a new password.',
};

export default function ForgotPassword() {
  // Without a mail provider there is no link to send, so the page would be a
  // form that silently does nothing.
  if (!publicAuthConfig().mail) redirect('/sign-in');
  return (
    <AuthShell
      eyebrow="ACCOUNT RECOVERY"
      title="Set a new password."
      subtitle="Tell us the address you signed up with and we will send a link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
