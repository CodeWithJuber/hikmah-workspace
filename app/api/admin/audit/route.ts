import { z } from 'zod';
import { authzStore, requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The audit trail: every admin mutation, newest first. Support staff may read
 * it — watching the operators is the point of the role — but nothing here
 * writes. */
export async function GET(request: Request) {
  try {
    await requirePermission('audit:read');
  } catch (error) {
    const status = error instanceof KernelHttpError ? error.status : 403;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Not allowed.' },
      { status, headers },
    );
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: 'Bad pagination.' }, { status: 400, headers });
  return Response.json(authzStore().listAudit(parsed.data.limit, parsed.data.offset), { headers });
}
