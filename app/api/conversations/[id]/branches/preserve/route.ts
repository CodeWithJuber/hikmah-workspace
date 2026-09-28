import { getChatGPTUser } from '../../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { createBranchStore } from '@/lib/runs/branches';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

function ownerConversation(id: string, userId: string) {
  const conversation = runService().store.getConversation(id);
  // A conversation that does not exist and one belonging to someone else are
  // answered identically, so the reply cannot be used to discover either.
  return conversation && conversation.user_id === userId ? conversation : null;
}

/**
 * Preserve an assistant answer as a branch before regenerating it.
 *
 * Regenerating used to delete the old answer; now the old answer becomes a
 * sibling of the new one ("‹ 1/2 ›"). This route takes the answer (and
 * whatever is visibly below it) off the active path and returns the parent
 * id, so the client can regenerate from the right message and the worker
 * writes the new answer under that parent.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  if (!ownerConversation(id, user.userId)) return fail('Conversation not found.', 404);

  let body: { messageId?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body with the message id.', 400);
  }
  const messageId = body.messageId;
  if (typeof messageId !== 'string' || !messageId)
    return fail('Send a JSON body with the message id.', 400);

  const outcome = createBranchStore(getStorage().raw).detachSubtree(id, user.userId, messageId);
  if ('forbidden' in outcome) return fail('Message not found.', 404);
  if ('notAssistant' in outcome) return fail('Only an assistant answer can be regenerated.', 400);
  return Response.json({ ok: true, parentId: outcome.parentId }, { headers });
}
