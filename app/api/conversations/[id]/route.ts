import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

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
