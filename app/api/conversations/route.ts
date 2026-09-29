import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { newConversationId, runService } from '@/lib/runs/service';
import { conversationTitle } from '@/lib/chat/title';

/** The row's preview line: the last message's first words, or '' when the
 * last message carried no words (a file, an image, a tool call). The list
 * shows the role marker itself when the text is empty, so an empty snippet
 * is honest, not a placeholder. */
function snippetFor(lastParts: unknown): string {
  if (typeof lastParts !== 'string') return '';
  try {
    return conversationTitle(JSON.parse(lastParts));
  } catch {
    return '';
  }
}

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
  const listed = runService().store.listConversations(
    user.userId,
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LISTED) : 100,
  );

  // The runs store's list query names its columns explicitly and knows nothing
  // about organization, which is this route's concern: pinned and project_id
  // are merged in from a second query rather than by touching the store. One
  // round trip for the listed ids, matched by id into a lookup.
  const organize = new Map<string, { pinned: number | null; project_id: string | null }>();
  if (listed.length > 0) {
    const placeholders = listed.map(() => '?').join(',');
    const found = getStorage()
      .raw.prepare(`SELECT id, pinned, project_id FROM conversations WHERE id IN (${placeholders})`)
      .all(...listed.map((row) => row.id)) as Array<{
      id: string;
      pinned: number | null;
      project_id: string | null;
    }>;
    for (const row of found) organize.set(row.id, row);
  }

  const conversations = listed
    .map((row) => {
      const org = organize.get(row.id);
      return {
        id: row.id,
        title: row.title,
        model: row.model,
        // A background task is listed apart from the chats, with how it ended
        // and how many suggestions it left for the person to look at.
        mode: row.mode === 'task' ? 'task' : 'chat',
        ended:
          row.run_status === 'done'
            ? 'done'
            : row.run_status === 'failed' || row.run_status === 'cancelled'
              ? 'stopped'
              : null,
        toReview: row.to_review,
        // Reported separately because they need different answers from the
        // owner: one is working, the other has stopped and is waiting on them.
        // Which kind of stop matters too — permission and a question ask for
        // different things — so the list says which rather than just "paused".
        running: row.run_status === 'queued' || row.run_status === 'running',
        waiting:
          row.run_status === 'waiting_approval'
            ? 'approval'
            : row.run_status === 'waiting_client'
              ? 'answer'
              : null,
        updatedAt: row.updated_at,
        // The native Chats screen's preview line: last message, one line.
        snippet: snippetFor(row.last_parts),
        snippetRole: row.last_role,
        // Pinned chats float to the top of the sidebar, in their own section.
        // A missing entry (row created while the column did not exist) reads
        // as unpinned rather than breaking the list.
        pinned: (org?.pinned ?? 0) === 1,
        // Which project folder this conversation is filed in, or null when it
        // is unfiled.
        projectId: org?.project_id ?? null,
      };
    })
    // Pinned first, recency order kept inside each group: the list above was
    // already ordered most-recently-active-first, and Array.sort is stable, so
    // this regroups without reshuffling anything else. Tasks never pin, so
    // their relative order is untouched.
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
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
