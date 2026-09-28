import { getChatGPTUser } from '../../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { createBranchStore } from '@/lib/runs/branches';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Edit a user message into a new branch.
 *
 * The message itself is never rewritten: a sibling row is created on the
 * active path and the old message's active-path subtree is taken off it, so
 * both versions survive and the "1/3" switcher can move between them. The
 * client then regenerates from the new message through the normal runs flow.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id, messageId } = await context.params;
  const store = runService().store;
  const conversation = store.getConversation(id);
  // Not this owner's, or not there at all: the same answer to both, so the
  // reply cannot be used to find out which.
  if (!conversation || conversation.user_id !== user.userId)
    return fail('Conversation not found.', 404);

  let body: { parts?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send the edited parts as JSON.', 400);
  }
  if (body.parts === undefined) return fail('Send the edited parts as JSON.', 400);

  const outcome = createBranchStore(getStorage().raw).editMessage(
    id,
    user.userId,
    messageId,
    body.parts,
  );
  if ('forbidden' in outcome) return fail('Conversation not found.', 404);
  if ('notUserMessage' in outcome)
    return fail('Only your own messages can be edited into a branch.', 400);
  return Response.json({ newId: outcome.newId }, { headers });
}
