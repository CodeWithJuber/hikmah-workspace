import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { createMemoryStore, type MemoryKind, type MemoryStatus } from '@/lib/memory/store';
import { createKnowledgeSources } from '@/lib/knowledge/store';
import { PROVENANCES, type Provenance } from '@/lib/playground/knowledge';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const store = () => createMemoryStore(getStorage().raw);

const KINDS = new Set<string>(['preference', 'reference']);
const STATUSES = new Set<string>(['suggested', 'saved', 'rejected']);

/**
 * A person's memories: what they saved, what the model suggested, what an
 * answer used.
 *
 * Its own table and its own route rather than the workspace blob, which only
 * the browser may write: a run writing the blob would race the open workspace
 * tab's revision and stop it saving for good. Personal knowledge that is still
 * in the blob is copied across the first time this is read, by the same code
 * the run uses, so the two can never show different lists.
 *
 * Cookie plus Sec-Fetch-Site on the read, Origin on the writes — the
 * chat-settings route's shape.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const storage = getStorage();
  // The one-time import lives in the run's knowledge sources; calling it here
  // means the screen and the run see the same rows from the first visit.
  await createKnowledgeSources(storage.raw, storage.BUCKET).memories?.(user.userId);
  const memories = store();
  return Response.json(
    {
      memories: memories.list(user.userId),
      counts: memories.counts(user.userId),
      recent: memories.recentlyUsed(user.userId).map((memory) => memory.id),
    },
    { headers },
  );
}

/** Remember something, in the person's own words. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('Send the memory to save.', 400);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return fail('Write what to remember.', 400);

  // What a person types here is their own words; the model's suggestions come
  // through the run, not this route, so 'inference' cannot be claimed as
  // 'quote' from the outside — only the reverse, which costs nothing.
  const provenance = (PROVENANCES as readonly string[]).includes(body.provenance as string)
    ? (body.provenance as Provenance)
    : 'quote';
  const conversationId =
    typeof body.sourceConversationId === 'string' ? body.sourceConversationId : null;
  // A memory taken from a message is named after its conversation: "You · <title>"
  // for the person's own words, "Hikmah · <title>" for an answer's.
  const title = conversationId
    ? (
        getStorage()
          .raw.prepare('SELECT title FROM conversations WHERE id = ? AND user_id = ?')
          .get(conversationId, user.userId) as { title?: string } | undefined
      )?.title
    : undefined;
  const saved = store().add(user.userId, {
    kind: KINDS.has(body.kind as string) ? (body.kind as MemoryKind) : 'reference',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    content,
    provenance,
    source:
      typeof body.source === 'string'
        ? body.source
        : title
          ? (provenance === 'quote' ? 'You · ' : 'Hikmah · ') + title
          : 'Added by you',
    sourceConversationId: conversationId,
    // Only a person's own words may be saved without review.
    status: provenance === 'quote' && body.status !== 'suggested' ? 'saved' : 'suggested',
  });
  if (!saved) return fail('That could not be saved. Up to 500 memories are kept.', 409);
  return Response.json(
    { memory: store().get(user.userId, saved.id), created: saved.created },
    { headers, status: saved.created ? 201 : 200 },
  );
}

/** Accept, edit, switch off or reject one memory. */
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== 'string') return fail('Say which memory to change.', 400);
  const memory = store().update(user.userId, body.id, {
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.content === 'string' ? { content: body.content } : {}),
    ...(KINDS.has(body.kind as string) ? { kind: body.kind as MemoryKind } : {}),
    ...(STATUSES.has(body.status as string) ? { status: body.status as MemoryStatus } : {}),
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
  });
  if (!memory) return fail('That memory was not found, or the edit would duplicate another.', 404);
  return Response.json({ memory }, { headers });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id || id.length > 80) return fail('Say which memory to forget.', 400);
  return Response.json({ removed: store().remove(user.userId, id) }, { headers });
}
