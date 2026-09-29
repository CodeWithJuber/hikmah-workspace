import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { createMemoryStore, normalizeExpiresAt, type MemoryKind } from '@/lib/memory/store';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const KINDS = new Set<string>(['preference', 'reference']);

/**
 * POST /api/memory/corrections — the user corrected the assistant, and the
 * correction must stick: remembered and applied going forward, not re-asked
 * next session.
 *
 * The correction is saved as a NEW memory linked to the old one via
 * `supersedes`; the old row is never edited in place, so the history
 * survives. Recall drops whatever a live row corrects, so the outdated fact
 * cannot override the newer one. A correction always lives in the same scope
 * as what it corrects.
 *
 * When the same memory already has another live correction, the two disagree
 * and the response says so (`conflicts`): one correction supersedes cleanly,
 * two need the person — see GET /api/memory?view=conflicts.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('Send the correction to save.', 400);
  if (typeof body.supersedesId !== 'string' || !body.supersedesId)
    return fail('Say which memory this corrects.', 400);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return fail('Write the corrected fact.', 400);

  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    expiresAt = normalizeExpiresAt(body.expiresAt);
    if (!expiresAt) return fail('Send expiresAt as an ISO timestamp, or leave it out.', 400);
  }

  const store = createMemoryStore(getStorage().raw);
  const corrected = store.addCorrection(user.userId, body.supersedesId, {
    kind: KINDS.has(body.kind as string) ? (body.kind as MemoryKind) : 'reference',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    content,
    // A correction the person typed is their own words.
    provenance: 'quote',
    source: 'Correction by you',
    sourceConversationId:
      typeof body.sourceConversationId === 'string' ? body.sourceConversationId : null,
    status: 'saved',
    expiresAt,
  });
  if (!corrected)
    return fail('That memory was not found, or the correction could not be saved.', 404);
  return Response.json(
    {
      memory: store.get(user.userId, corrected.id),
      supersedes: body.supersedesId,
      conflicts: corrected.conflicts,
    },
    { headers, status: corrected.created ? 201 : 200 },
  );
}
