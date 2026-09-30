import { ownerIdentity, sameOrigin, failure, KernelHttpError } from '@/lib/kernel/server';
import { getStorage } from '@/server/storage.mjs';
import { createReleaseStore, LearningReleaseError } from '@/lib/learning/releases';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const store = () => createReleaseStore(getStorage().raw);

async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LearningReleaseError('bad-body', 'Send a JSON request body.', 400);
  const text = await request.text();
  if (text.length > 32_000)
    throw new LearningReleaseError('too-large', 'Use a shorter approval.', 413);
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LearningReleaseError('bad-body', 'Send an approval decision.', 400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LearningReleaseError) throw error;
    throw new LearningReleaseError('bad-body', 'Send a valid JSON request body.', 400);
  }
}

/** Approve or reject a proposed release. A decision is recorded with the
 * owner's reason — silent approvals are refused. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await ownerIdentity();
    sameOrigin(request);
    const body = await readBody(request);
    if (body.decision !== 'approved' && body.decision !== 'rejected')
      return fail('Decide approved or rejected.', 400);
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000)
      return fail('Record a reason for the decision.', 400);
    const releases = store();
    releases.recordApproval({
      releaseId: params.id,
      approver: user.userId,
      decision: body.decision,
      reason: body.reason,
    });
    releases.setStatus(params.id, body.decision === 'approved' ? 'approved' : 'rejected', [
      'proposed',
    ]);
    return Response.json({ release: releases.release(params.id) }, { headers });
  } catch (error) {
    if (error instanceof LearningReleaseError) return fail(error.message, error.status);
    if (error instanceof KernelHttpError) return failure(error);
    return fail('The approval could not be recorded. Try again.', 503);
  }
}
