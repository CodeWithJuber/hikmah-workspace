import { getChatGPTUser } from '../../../chatgpt-auth';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore } from '@/lib/catalog/store';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Which of the caller's installs have a newer version available, and
 * whether the update widens permissions (needs explicit re-grant). */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    const store = createCatalogStore(getStorage().raw);
    return Response.json({ updates: store.updateCheck(user.userId) }, { headers });
  } catch {
    return fail('The catalog is unavailable. Try again.', 503);
  }
}
