import { getChatGPTUser } from '../../../../chatgpt-auth';
import { runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/**
 * The stored transcript for one conversation.
 *
 * Resuming a run is not enough on its own: a reload rejoins the answer being
 * written but would show it with nothing above it, because the messages are
 * rows on the server rather than state in the tab. This is where the tab gets
 * them back.
 *
 * Authenticated by session cookie plus Sec-Fetch-Site rather than Origin, for
 * the same reason the stream route is: a browser sends no Origin on a
 * same-origin GET, so requiring one would reject every reload.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
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
    return Response.json({ messages: [] }, { headers });

  // The reason the last run failed, when it did. Without it, reopening a
  // conversation that had failed showed the question, no answer, and nothing
  // to say why: the browser only tails a run it thinks is active, and a failed
  // run is not.
  return Response.json(
    { messages: store.listMessages(id), error: store.lastFailure(id) ?? undefined },
    { headers },
  );
}
