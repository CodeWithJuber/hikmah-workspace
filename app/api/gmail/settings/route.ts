import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { gmailContext } from '@/lib/gmail/app-context';
import { settingsRequest } from '@/lib/gmail/api';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

async function handle(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  return settingsRequest(request, gmailContext(request, user.userId));
}

export const GET = handle;
export const PATCH = handle;
