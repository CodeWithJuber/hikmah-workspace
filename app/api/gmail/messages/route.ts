import { getChatGPTUser } from '../../../chatgpt-auth';
import { gmailContext } from '@/lib/gmail/app-context';
import { messagesRequest } from '@/lib/gmail/api';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  return messagesRequest(request, gmailContext(request, user.userId));
}
