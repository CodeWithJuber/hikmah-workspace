import { getStorage } from '@/server/storage.mjs';
import { createSharesStore } from '@/lib/chat/shares-store';
import { runService } from '@/lib/runs/service';
import { sharedMessageText } from '@/lib/chat/share-text';

export const dynamic = 'force-dynamic';

const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  // A shared link is read-only content the owner chose to publish; it should
  // not be framed, and it should not leak where it was opened from.
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Read a shared conversation. No auth: the token IS the authorization, which
 * is why the reply carries only the title and the message texts — never the
 * owner's id, never the model's name, never run metadata.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const resolved = createSharesStore(getStorage().raw).resolveToken(token);
  if (!resolved) return fail('Not found.', 404);

  const raw = getStorage().raw;
  const row = raw
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .get(resolved.conversation_id) as { title?: string } | undefined;
  if (!row) return fail('Not found.', 404);

  const messages = runService()
    .store.listMessages(resolved.conversation_id)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: sharedMessageText(message.parts),
    }))
    .filter((message) => message.text.length > 0);
  return Response.json({ title: row.title ?? '', messages }, { headers });
}
