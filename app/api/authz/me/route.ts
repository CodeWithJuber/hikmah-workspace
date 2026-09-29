import { requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/** Who the caller is allowed to be: their staff role and its permissions, or
 * null for a plain account. The nav reads this to decide whether the Staff
 * console exists for them; the routes re-check on every call, so this answer
 * is convenience, not authority. */
export async function GET() {
  try {
    const { user, role, permissions } = await requirePermission('users:read');
    return Response.json({ userId: user.userId, role, permissions }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError && error.status === 401)
      return Response.json(
        { error: 'Sign in to your private workspace.' },
        { status: 401, headers },
      );
    // 403 here means "no staff role": a plain account, which is the common
    // case and not an error worth alarming about.
    return Response.json({ userId: null, role: null, permissions: [] }, { headers });
  }
}
