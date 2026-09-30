import { ownerIdentity, sameOrigin, failure, KernelHttpError } from '@/lib/kernel/server';
import { getStorage } from '@/server/storage.mjs';
import { createReleaseStore, planRollback, LearningReleaseError } from '@/lib/learning/releases';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const store = () => createReleaseStore(getStorage().raw);

/** Roll back a live or canarying release to the previous version.
 * First-class operation: the release is deactivated and the release it
 * superseded is reactivated. Datasets, holdouts, canary records and metrics
 * are never deleted — the audit trail survives the rollback. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await ownerIdentity();
    sameOrigin(request);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new LearningReleaseError('bad-body', 'Send a JSON request body.', 400);
    const text = await request.text();
    if (text.length > 32_000)
      throw new LearningReleaseError('too-large', 'Use a shorter rollback reason.', 413);
    let reason: string;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      reason = typeof body.reason === 'string' ? body.reason : '';
    } catch {
      throw new LearningReleaseError('bad-body', 'Send a valid JSON request body.', 400);
    }
    if (!reason.trim() || reason.length > 2000)
      return fail('Record a reason for the rollback.', 400);
    const releases = store();
    // Validate the plan before touching state: only the active release can
    // be rolled back, and it must supersede a previous version.
    const plan = planRollback(releases.listReleases());
    if (plan.deactivateId !== id)
      return fail(`Release ${id} is not the active release; ${plan.deactivateId} is.`, 409);
    const result = releases.rollback({
      releaseId: id,
      approver: user.userId,
      reason,
    });
    return Response.json({ ...result }, { headers });
  } catch (error) {
    if (error instanceof LearningReleaseError) return fail(error.message, error.status);
    if (error instanceof KernelHttpError) return failure(error);
    return fail('The rollback could not be recorded. Try again.', 503);
  }
}
