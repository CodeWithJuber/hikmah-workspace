import { z } from 'zod';
import {
  assertGrantable,
  audit,
  authzStore,
  requirePermission,
  targetAccount,
} from '@/lib/authz/server';
import { hasPermission } from '@/lib/authz/roles';
import { billingStore } from '@/lib/billing/server';
import { isTier } from '@/lib/billing/plans';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const bodySchema = z
  .object({
    /** Manual tier override. The owner tier is never settable: it comes from
     * the id-pinned kernel_owners row, not from anyone's decision. */
    tier: z.enum(['byok', 'managed']).optional(),
    /** Grant the support role, or null to revoke it. */
    role: z.union([z.literal('support'), z.null()]).optional(),
    /** Ban or unban the account. */
    banned: z.boolean().optional(),
    reason: z.string().trim().max(280).optional(),
  })
  .refine(
    (body) => body.tier !== undefined || body.role !== undefined || body.banned !== undefined,
    {
      message: 'Nothing to change.',
    },
  );

/** Mutate one account: tier override, staff role, ban. Each field needs its
 * own permission, each change writes one audit row, and the pinned owner is
 * untouchable — including by themselves, so no misclick can demote the
 * operator or lock them out. No-ops are skipped silently, so a retried
 * request does not write a second audit row. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: targetId } = await params;
  if (!targetId || targetId.length > 128)
    return Response.json({ error: 'Unknown account.' }, { status: 404, headers });

  let grant;
  try {
    grant = await requirePermission('users:read');
  } catch (error) {
    return fail(error);
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: 'Nothing valid to change.' }, { status: 400, headers });
  const body = parsed.data;

  // The account must exist and must not be the pinned operator: verified,
  // never trusted (OWASP API#1).
  let target;
  try {
    target = await targetAccount(targetId);
  } catch (error) {
    return fail(error);
  }
  const targetEmail = target.email;
  if (body.banned === true && targetId === grant.user.userId)
    return Response.json({ error: 'You cannot ban your own account.' }, { status: 400, headers });

  const need = (permission: 'users:manage' | 'billing:override') =>
    hasPermission(grant.role, permission)
      ? null
      : Response.json(
          { error: 'This needs a staff role your account does not have.' },
          { status: 403, headers },
        );

  const changes: string[] = [];
  const billing = billingStore();
  const authz = authzStore();

  if (body.tier !== undefined) {
    const denied = need('billing:override');
    if (denied) return denied;
    if (!isTier(body.tier))
      return Response.json({ error: 'Unknown tier.' }, { status: 400, headers });
    if (billing.savedTier(targetId) !== body.tier) {
      billing.setTier(targetId, body.tier);
      audit(grant.user.userId, 'tier.override', targetId, `tier -> ${body.tier} (manual)`);
      changes.push(`tier -> ${body.tier}`);
    }
  }
  if (body.role !== undefined) {
    const denied = need('users:manage');
    if (denied) return denied;
    if (body.role === null) {
      if (authz.getRole(targetId) !== null) {
        authz.removeRole(targetId);
        audit(grant.user.userId, 'role.revoke', targetId, 'support revoked');
        changes.push('role revoked');
      }
    } else {
      assertGrantable(body.role);
      if (authz.getRole(targetId) !== body.role) {
        authz.setRole(targetId, body.role, grant.user.userId);
        audit(grant.user.userId, 'role.grant', targetId, `role -> ${body.role}`);
        changes.push(`role -> ${body.role}`);
      }
    }
  }
  if (body.banned !== undefined) {
    const denied = need('users:manage');
    if (denied) return denied;
    if (body.banned && !authz.isBanned(targetId)) {
      authz.setBanned(targetId, grant.user.userId, body.reason ?? null);
      audit(grant.user.userId, 'user.ban', targetId, body.reason || 'no reason given');
      changes.push('banned');
    } else if (!body.banned && authz.isBanned(targetId)) {
      authz.clearBanned(targetId);
      audit(grant.user.userId, 'user.unban', targetId, null);
      changes.push('unbanned');
    }
  }

  return Response.json(
    { ok: true, changes, target: { id: targetId, email: targetEmail } },
    { headers },
  );
}

function fail(error: unknown) {
  const status = error instanceof KernelHttpError ? error.status : 500;
  return Response.json(
    { error: error instanceof Error ? error.message : 'The change could not be made.' },
    { status, headers },
  );
}
