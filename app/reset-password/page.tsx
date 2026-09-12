import { AuthShell } from '@/components/auth/auth-shell';
import { ResetPasswordForm } from '@/components/auth/password-reset-forms';

export const dynamic = 'force-dynamic';

// The token arrives in the query string of the emailed link. Read on the server
// so it never has to round-trip through client state.
export default async function ResetPassword({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = (await searchParams).token;
  return (
    <AuthShell eyebrow="ACCOUNT RECOVERY" title="Choose a new password.">
      <ResetPasswordForm token={typeof token === 'string' ? token : ''} />
    </AuthShell>
  );
}
