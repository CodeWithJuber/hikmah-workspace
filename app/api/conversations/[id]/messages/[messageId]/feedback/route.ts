import { getChatGPTUser } from '../../../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { runService } from '@/lib/runs/service';
import { createFeedbackStore, FeedbackNotFound } from '@/lib/chat/feedback-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

type Params = { params: Promise<{ id: string; messageId: string }> };

function feedbackStore() {
  return createFeedbackStore(getStorage().raw);
}

/**
 * Rate one message: thumbs up / down / clear.
 *
 * PUT { value: 'up' | 'down' | null }. Rating again replaces the earlier
 * value; null clears it. Origin-checked because it mutates, and the message
 * must belong to a conversation the caller owns — the store verifies that
 * join itself, and the answer for "not yours" is the same as "not there".
 */
export async function PUT(request: Request, context: Params) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id, messageId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body with a value.', 400);
  }
  const value = (body as { value?: unknown } | null)?.value;
  if (value !== 'up' && value !== 'down' && value !== null)
    return fail("value must be 'up', 'down' or null.", 400);

  try {
    feedbackStore().setFeedback(messageId, id, user.userId, value);
  } catch (error) {
    if (error instanceof FeedbackNotFound) return fail('Message not found.', 404);
    throw error;
  }
  return Response.json({ ok: true }, { headers });
}

/**
 * Every rating on one conversation: { feedback: { messageId: 'up'|'down' } }.
 *
 * Read-only, so like the messages route this is authenticated by session
 * cookie plus Sec-Fetch-Site rather than Origin — a browser sends no Origin
 * on a same-origin GET. Another owner's conversation reads as empty, the
 * same way its messages do.
 */
export async function GET(request: Request, context: Params) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return Response.json(
      { error: 'Use this from your signed-in workspace.' },
      { status: 403, headers },
    );

  const { id } = await context.params;
  const store = runService().store;
  const conversation = store.getConversation(id);
  // A conversation that does not exist and one belonging to someone else are
  // answered identically, so the reply cannot be used to discover either.
  if (!conversation || conversation.user_id !== user.userId)
    return Response.json({ feedback: {} }, { headers });

  return Response.json({ feedback: feedbackStore().getFeedback(id, user.userId) }, { headers });
}
