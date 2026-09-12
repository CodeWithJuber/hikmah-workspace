import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { createChatSettingsStore } from '@/lib/chat/settings-store';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const store = () => createChatSettingsStore(getStorage().raw);

/**
 * The owner's preferences for the chat surface.
 *
 * Kept apart from `/api/workspace-state` on purpose. That route guards the
 * workspace blob with a revision CAS, and a losing write makes the workspace
 * tab stop saving for the rest of its life — so a second surface writing it
 * would not merge, it would break the first.
 *
 * Cookie plus Sec-Fetch-Site on the read, as on the other read paths: a browser
 * sends no Origin on a same-origin GET, so requiring one would reject every
 * page load.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  return Response.json({ settings: store().read(user.userId) }, { headers });
}

/** Fold a change into the stored settings and return the result. */
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('Send the settings to change.', 400);

  // A merge, so a tab that predates a field cannot reset one it has never heard
  // of. Every value is clamped or dropped by the parser, so an out-of-range
  // number is corrected rather than refused.
  return Response.json({ settings: store().update(user.userId, body) }, { headers });
}
