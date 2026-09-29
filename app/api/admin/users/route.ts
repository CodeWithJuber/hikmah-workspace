import { z } from 'zod';
import { authDatabase, authzStore, requirePermission, roleForUser } from '@/lib/authz/server';
import { billingStore } from '@/lib/billing/server';
import { resolveTier, periodStart } from '@/lib/billing/entitlements';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(120).default(''),
});

type AuthUser = { id: string; name: string | null; email: string; createdAt: string | number };

/** The staff console's user list: every account, with the columns an operator
 * needs — tier, staff role, ban state, this month's usage.
 *
 * Reads better-auth's own rows read-only (id, name, email, createdAt only) and
 * joins the app's tables in memory. Paginated, because a launch that works is
 * a launch with more than fifty accounts. */
export async function GET(request: Request) {
  try {
    await requirePermission('users:read');
  } catch (error) {
    return forbidden(error);
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: 'Bad pagination.' }, { status: 400, headers });
  const { limit, offset, q } = parsed.data;
  // LIKE wildcards in the search are literal text, not pattern syntax.
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

  let authRows: AuthUser[];
  try {
    const db = authDatabase();
    authRows = q
      ? (db
          .prepare(
            "SELECT id, name, email, createdAt FROM user WHERE email LIKE ? ESCAPE '\\' ORDER BY createdAt DESC LIMIT ? OFFSET ?",
          )
          .all(like, limit, offset) as AuthUser[])
      : (db
          .prepare(
            'SELECT id, name, email, createdAt FROM user ORDER BY createdAt DESC LIMIT ? OFFSET ?',
          )
          .all(limit, offset) as AuthUser[]);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof KernelHttpError ? error.message : 'The account list could not be read.',
      },
      { status: error instanceof KernelHttpError ? error.status : 500, headers },
    );
  }

  const total = (() => {
    try {
      const db = authDatabase();
      const row = (
        q
          ? db.prepare("SELECT COUNT(*) AS n FROM user WHERE email LIKE ? ESCAPE '\\'").get(like)
          : db.prepare('SELECT COUNT(*) AS n FROM user').get()
      ) as { n: number };
      return row.n;
    } catch {
      return authRows.length;
    }
  })();

  const billing = billingStore();
  const authz = authzStore();
  const from = periodStart();
  const ownerUserId = billing.ownerUserId();
  const ownerEmail = process.env.HIKMAH_OWNER_EMAIL ?? '';

  const users = await Promise.all(
    authRows.map(async (row) => {
      // The tier rule is the same one the run route enforces: the owner is
      // never demoted by a stale row, everyone else reads user_tiers.
      const tier = resolveTier({
        userId: row.id,
        email: row.email,
        ownerUserId,
        ownerEmail,
        saved: billing.savedTier(row.id),
      });
      const usage = billing.usageThisMonth(row.id, from);
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: row.createdAt,
        tier,
        role: await roleForUser(row.id),
        banned: authz.isBanned(row.id),
        usage: { ...usage, metered: billing.meteredThisMonth(row.id, from) },
      };
    }),
  );
  return Response.json({ users, total, limit, offset }, { headers });
}

function forbidden(error: unknown) {
  const status = error instanceof KernelHttpError ? error.status : 403;
  return Response.json(
    { error: error instanceof Error ? error.message : 'Not allowed.' },
    { status, headers },
  );
}
