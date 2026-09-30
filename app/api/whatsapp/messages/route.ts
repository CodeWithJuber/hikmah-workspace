import { getChatGPTUser } from '../../../chatgpt-auth';
import { messagesRequest } from '@/lib/whatsapp/api';
import { whatsappContext } from '@/lib/whatsapp/app-context';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  return messagesRequest(request, whatsappContext(request, user.userId));
}
