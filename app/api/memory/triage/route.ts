import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import {
  getPolicy,
  listDecisions,
  setPolicy,
  undoDecision,
  type TriagePolicy,
} from '@/lib/memory/triage';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Reads use the sec-fetch-site shape (same as app/api/memory/route.ts);
 * writes require the same-origin Origin check. */
function readGuard(request: Request): string | null {
  const site = request.headers.get('sec-fetch-site');
  return site && site !== 'same-origin' && site !== 'none'
    ? 'Use this from your signed-in workspace.'
    : null;
}

async function requireUser(request: Request, write: boolean) {
  const user = await getChatGPTUser();
  if (!user) return { error: fail('Sign in to your private workspace.', 401) as Response };
  if (write) {
    if (request.headers.get('origin') !== publicOrigin(request))
      return { error: fail('Use this from your signed-in workspace.', 403) as Response };
  } else {
    const blocked = readGuard(request);
    if (blocked) return { error: fail(blocked, 403) as Response };
  }
  return { user };
}

/**
 * GET: the standing triage policy plus the recent auto-decision audit trail —
 * what triage decided on its own, and why. The policy is one shared standing
 * policy for the workspace; memories themselves stay user-scoped in the
 * store underneath.
 */
export async function GET(request: Request) {
  const auth = await requireUser(request, false);
  if ('error' in auth) return auth.error;
  const handle = getStorage().raw;
  return Response.json(
    { policy: getPolicy(handle), decisions: listDecisions(handle, 50) },
    { headers },
  );
}

/**
 * PUT: update the standing triage policy. The body is merged over the
 * current policy, so a partial update works; setPolicy normalizes unknown
 * fields back to defaults. updatedBy is forced to 'user'.
 */
export async function PUT(request: Request) {
  const auth = await requireUser(request, true);
  if ('error' in auth) return auth.error;
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return fail('Send a JSON object with the policy fields to change.', 400);
  }
  if (typeof body !== 'object' || body === null)
    return fail('Send a JSON object with the policy fields to change.', 400);
  const handle = getStorage().raw;
  const current = getPolicy(handle);
  const next: TriagePolicy = {
    ...current,
    ...(body as Partial<TriagePolicy>),
    updatedBy: 'user',
  };
  setPolicy(handle, next);
  return Response.json({ policy: getPolicy(handle) }, { headers });
}

/**
 * POST {"action":"undo","decisionId"}: revert one triage decision. Only a
 * 'save' decision flips a memory (to 'rejected'); the undo is itself audited.
 * Unknown decision ids are a no-op.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request, true);
  if ('error' in auth) return auth.error;
  let body: { action?: unknown; decisionId?: unknown };
  try {
    body = (await request.json()) as { action?: unknown; decisionId?: unknown };
  } catch {
    return fail('Send {"action":"undo","decisionId":"..."}.', 400);
  }
  if (body.action !== 'undo' || typeof body.decisionId !== 'string' || !body.decisionId)
    return fail('Send {"action":"undo","decisionId":"..."}.', 400);
  undoDecision(getStorage().raw, body.decisionId);
  return Response.json({ ok: true }, { headers });
}
