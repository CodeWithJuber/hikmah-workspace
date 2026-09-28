import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { getStorage } from '@/server/storage.mjs';
import { createSharesStore } from '@/lib/chat/shares-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

function ownedConversation(id: string, userId: string) {
  const conversation = runService().store.getConversation(id);
  return conversation && conversation.user_id === userId ? conversation : null;
}

/** Whether this conversation currently has an active share link. The dialog
 * asks this first, so it can offer "copy the new link" vs "revoke" without
 * minting a second token by accident. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  // Same answer whether the conversation is missing or someone else's.
  if (!ownedConversation(id, user.userId)) return fail('Conversation not found.', 404);

  const existing = createSharesStore(getStorage().raw).activeShare(id, user.userId);
  return Response.json(
    { shared: Boolean(existing), createdAt: existing?.created_at ?? null },
    { headers },
  );
}

/**
 * Create a share link. At most one link is ever active per conversation: an
 * existing one is revoked first, so there is never a pile of forgotten links
 * to audit, and the plaintext token returned here is the only one that works.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  if (!ownedConversation(id, user.userId)) return fail('Conversation not found.', 404);

  const store = createSharesStore(getStorage().raw);
  store.revokeShare(id, user.userId);
  const { token } = store.createShare(id, user.userId);
  return Response.json(
    { token, url: `${publicOrigin(request)}/share/${token}` },
    { headers, status: 201 },
  );
}

/** Revoke the conversation's share link. Revoking a link that was never made
 * is still a success — the end state is what was asked for. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  if (!ownedConversation(id, user.userId)) return fail('Conversation not found.', 404);

  createSharesStore(getStorage().raw).revokeShare(id, user.userId);
  return Response.json({ revoked: true }, { headers });
}
