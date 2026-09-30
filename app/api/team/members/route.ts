import { getChatGPTUser } from '../../../chatgpt-auth';
import { teamStore } from '@/lib/team/server';
import { isTeamRole } from '@/lib/team/roles';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Workspace membership.
 *
 * Invites are in-app records, never external sends: POST creates a 'pending'
 * row the invitee accepts by activating. DELETE deactivates — the row stays
 * with status 'removed', so the grant history survives for audit. Only the
 * workspace owner invites, activates and removes.
 */

function workspaceOr404(workspaceId: string, callerId: string) {
  const store = teamStore();
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace || workspace.ownerUserId !== callerId)
    throw new KernelHttpError(404, 'Workspace not found.');
  return { store, workspace };
}

/** List the workspace's members (owner only). */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? '';
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    return Response.json({ members: store.listMembers(workspaceId) }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}

/** Invite a user: creates the pending in-app record. No email is sent. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  let body: { workspace_id?: unknown; user_id?: unknown; team_role?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body.', 400);
  }
  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : '';
  const targetId = typeof body.user_id === 'string' ? body.user_id : '';
  if (!workspaceId || !targetId || targetId.length > 128)
    return fail('workspace_id and user_id are required.', 400);
  if (targetId === user.userId) return fail('You already own this workspace.', 400);
  if (!isTeamRole(body.team_role)) return fail("team_role must be 'member' or 'viewer'.", 400);
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    const member = store.inviteMember(workspaceId, targetId, body.team_role, user.userId);
    return Response.json({ member }, { status: 201, headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}

/** Remove a member: deactivates the row (status 'removed'), never deletes. */
export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get('workspace_id') ?? '';
  const targetId = params.get('user_id') ?? '';
  if (!workspaceId || !targetId) return fail('workspace_id and user_id are required.', 400);
  try {
    const { store } = workspaceOr404(workspaceId, user.userId);
    const removed = store.removeMember(workspaceId, targetId);
    if (!removed) return fail('No active membership to remove.', 404);
    return Response.json({ member: store.getMember(workspaceId, targetId) }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}
