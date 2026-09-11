import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { newConversationId, runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** More than a sidebar can usefully show, and a bound on the reply's size. */
const MAX_LISTED = 200;

/**
 * The owner's conversations, most recently active first.
 *
 * Cookie plus Sec-Fetch-Site rather than an Origin check, as elsewhere on the
 * read paths: a browser sends no Origin on a same-origin GET, so requiring one
 * would reject the sidebar's own request.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const limit = Number.parseInt(new URL(request.url).searchParams.get('limit') ?? '', 10);
  const conversations = runService()
    .store.listConversations(
      user.userId,
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LISTED) : 100,
    )
    .map((row) => ({
      id: row.id,
      title: row.title,
      model: row.model,
      // Reported separately because they need different answers from the
      // owner: one is working, the other has stopped and is waiting on them.
      running: row.run_status === 'queued' || row.run_status === 'running',
      awaitingApproval: row.run_status === 'waiting_approval',
      updatedAt: row.updated_at,
    }));
  return Response.json({ conversations }, { headers });
}

/**
 * Start a conversation.
 *
 * The row is not created here — the first message creates it, so an abandoned
 * "New chat" click leaves nothing behind and the list shows only conversations
 * that were actually used. What this returns is the id to use.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);
  return Response.json({ id: newConversationId() }, { headers, status: 201 });
}
