import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { gmailContext } from '@/lib/gmail/app-context';
import { oauthRequest } from '@/lib/gmail/api';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

async function handle(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  // The callback is a GET from Google's redirect, so it carries no Origin of
  // ours; the CSRF state bound to the signed-in owner is the check there.
  // POST (starting a grant) must carry our own Origin.
  if (request.method === 'POST' && request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  return oauthRequest(request, gmailContext(request, user.userId));
}

export const GET = handle;
export const POST = handle;
