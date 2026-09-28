import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { getStorage } from '@/server/storage.mjs';
import { createProjectsStore } from '@/lib/chat/projects-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Rename, pin/unpin, or file a conversation into a project.
 *
 * Renaming deliberately allows a title that is already set — unlike the runs
 * store's setTitle, which only fills in an empty one — because this is the
 * owner asking, not a run guessing. Each field is optional; only the ones
 * present are applied, so one request can rename and file in a single round
 * trip.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  const conversation = runService().store.getConversation(id);
  // Not this owner's, or not there at all: the same answer to both, so the
  // reply cannot be used to find out which.
  if (!conversation || conversation.user_id !== user.userId)
    return fail('Conversation not found.', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const patch = (typeof body === 'object' && body !== null ? body : {}) as {
    title?: unknown;
    pinned?: unknown;
    projectId?: unknown;
  };
  const store = createProjectsStore(getStorage().raw);

  if (patch.title !== undefined) {
    const title = String(patch.title ?? '');
    if (title.trim().length > 200) return fail('Keep the title under 200 characters.', 400);
    store.renameConversation(id, user.userId, title);
  }
  if (patch.pinned !== undefined) {
    store.setPinned(id, user.userId, patch.pinned === true);
  }
  if (patch.projectId !== undefined) {
    const projectId = patch.projectId === null ? null : String(patch.projectId ?? '');
    if (projectId !== null && !projectId)
      return fail('Pass a project id, or null to unfile the conversation.', 400);
    const moved = store.moveConversation(id, user.userId, projectId);
    // The only way this fails with an owned conversation is a project id that
    // is not this owner's.
    if (!moved) return fail('Project not found.', 404);
  }
  return Response.json({ updated: true }, { headers });
}

/**
 * Delete a conversation and everything under it.
 *
 * A conversation still answering is stopped first rather than refused: asking
 * the owner to press Stop before they are allowed to delete something is a
 * worse answer than doing it for them, and the run is theirs either way. The
 * rows go together through ON DELETE CASCADE, so this cannot leave a run queued
 * against a conversation that no longer exists.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  const worker = runService();
  const conversation = worker.store.getConversation(id);
  // Not this owner's, or not there at all: the same answer to both, so the
  // reply cannot be used to find out which.
  if (!conversation || conversation.user_id !== user.userId)
    return fail('Conversation not found.', 404);

  const active = worker.store.activeForConversation(id);
  if (active) worker.cancel(active);

  const deleted = worker.store.deleteConversation(id, user.userId);
  return Response.json({ deleted }, { headers });
}
