import { randomUUID } from 'node:crypto';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { createBranchStore } from '@/lib/runs/branches';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Fork a conversation from any message.
 *
 * Copies the active path up to and including the message into a new
 * conversation owned by the same user — a fresh thread that keeps the
 * context so far, without disturbing the original's branches.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  const store = runService().store;
  const conversation = store.getConversation(id);
  // Not this owner's, or not there at all: the same answer to both, so the
  // reply cannot be used to find out which.
  if (!conversation || conversation.user_id !== user.userId)
    return fail('Conversation not found.', 404);

  let body: { messageId?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send the message id as JSON.', 400);
  }
  if (typeof body.messageId !== 'string' || !body.messageId)
    return fail('Send the message id as JSON.', 400);

  const forked = createBranchStore(getStorage().raw).forkConversation(
    id,
    user.userId,
    body.messageId,
    'conv_' + randomUUID(),
  );
  if (!forked) return fail('Message not found.', 404);
  return Response.json({ id: forked.id }, { headers });
}
