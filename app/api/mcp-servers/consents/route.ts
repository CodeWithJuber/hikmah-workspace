import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { consentsRequest } from '@/lib/mcp/consents-api';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

async function handle(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  // Writes must carry our own Origin. A GET does not: browsers omit it on
  // same-origin GETs, so requiring it would break the list for everyone.
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  return consentsRequest(request, { db: getStorage().raw, userId: user.userId });
}

export const GET = handle;
export const DELETE = handle;
