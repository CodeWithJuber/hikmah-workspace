import { getChatGPTUser } from '../../../../chatgpt-auth';
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
 * The sibling group of one message — the "‹ 1/3 ›" switcher data.
 *
 * Authenticated by session cookie plus Sec-Fetch-Site rather than Origin, the
 * same as the messages route: a browser sends no Origin on a same-origin GET.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  if (!ownerConversation(id, user.userId)) return fail('Conversation not found.', 404);

  const messageId = new URL(request.url).searchParams.get('messageId');
  if (!messageId) return fail('Pass the message as ?messageId=.', 400);

  const siblings = createBranchStore(getStorage().raw).siblingsOf(id, messageId);
  if (!siblings) return fail('Message not found.', 404);
  return Response.json(siblings, { headers });
}

/**
 * Switch the active branch to the one containing the given message.
 *
 * The flip happens in a single transaction, so the transcript the worker and
 * the UI read never points at two branches at once.
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
    return fail('Send the message id as JSON.', 400);
  }
  if (typeof body.messageId !== 'string' || !body.messageId)
    return fail('Send the message id as JSON.', 400);

  const switched = createBranchStore(getStorage().raw).setActiveBranch(
    id,
    user.userId,
    body.messageId,
  );
  if (!switched) return fail('Message not found.', 404);
  return Response.json(switched, { headers });
}
