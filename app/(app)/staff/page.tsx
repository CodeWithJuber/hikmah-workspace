import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';
import { StaffConsole } from '@/components/staff/staff-console';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Staff console · Hikmah' };

/** The operator console: users, usage, tier overrides, refunds, bans, and the
 * audit trail. The owner and the read-only support role get in; everyone else
 * sees a plain "not for you" rather than a redirect loop. Every mutation the
 * console offers re-checks its permission on the API route — this gate is the
 * door, not the lock. */
export default async function StaffPage() {
  let grant;
  try {
    grant = await requirePermission('users:read');
  } catch (error) {
    if (error instanceof KernelHttpError && error.status === 401) redirect('/sign-in');
    return (
      <main className="staff-page">
        <div className="staff">
          <h1>Staff console</h1>
          <p className="staff-muted">
            This area is for the deployment&apos;s operators. If you run this deployment, sign in
            with the operator account.
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="staff-page">
      <StaffConsole role={grant.role} permissions={grant.permissions} />
    </main>
  );
}
