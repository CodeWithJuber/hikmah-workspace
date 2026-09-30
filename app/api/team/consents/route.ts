import { getChatGPTUser } from '../../../chatgpt-auth';
import { teamStore } from '@/lib/team/server';
import { roleForUser } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Consented content access.
 *
 * Support staff see METADATA by default (see /api/team/support-view) and
 * never content. Reading a person's actual content needs an explicit grant
 * from the workspace owner, recorded here with an optional expiry. Grants are
 * revoked by timestamping (revoked_at), never by deleting the row. Every
 * consented read is written to team_content_access_log by the reader route
 * (/api/team/content), which the owner can review at /api/team/access-log.
 */

function workspaceOr404(workspaceId: string, callerId: string) {
  const store = teamStore();
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace || workspace.ownerUserId !== callerId)
    throw new KernelHttpError(404, 'Workspace not found.');
  return { store, workspace };
}

/** List the workspace's consent grants (owner only). */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? '';
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    return Response.json({ consents: store.listConsents(workspaceId) }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}

/** Grant a support staff member content access. The grantee must actually hold
 * a staff role — a grant to a random account would be meaningless — and the
 * grant is a row with an optional expiry, not a flag on the user. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  let body: { workspace_id?: unknown; staff_user_id?: unknown; expires_at?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body.', 400);
  }
  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : '';
  const staffUserId = typeof body.staff_user_id === 'string' ? body.staff_user_id : '';
  if (!workspaceId || !staffUserId || staffUserId.length > 128)
    return fail('workspace_id and staff_user_id are required.', 400);
  if (staffUserId === user.userId)
    return fail('You do not need a grant for your own content.', 400);
  const expiresAt = typeof body.expires_at === 'string' && body.expires_at ? body.expires_at : null;
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    const role = await roleForUser(staffUserId);
    if (role !== 'support' && role !== 'owner')
      return fail('Grants go to staff accounts (support or owner) only.', 400);
    const consent = store.grantContentConsent(workspaceId, staffUserId, user.userId, expiresAt);
    return Response.json({ consent }, { status: 201, headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}

/** Revoke a grant: timestamps revoked_at, never deletes the row. */
export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get('workspace_id') ?? '';
  const staffUserId = params.get('staff_user_id') ?? '';
  if (!workspaceId || !staffUserId)
    return fail('workspace_id and staff_user_id are required.', 400);
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    const revoked = store.revokeContentConsent(workspaceId, staffUserId);
    if (!revoked) return fail('No active grant to revoke.', 404);
    return Response.json({ consent: store.getConsent(workspaceId, staffUserId) }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}
