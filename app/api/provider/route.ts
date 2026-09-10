import { getChatGPTUser } from '../../chatgpt-auth';
import { relayProviderRequest } from '@/lib/server/provider-relay';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return relayProviderRequest(request, Boolean(await getChatGPTUser()));
}
export const GET = handle;
export const POST = handle;
