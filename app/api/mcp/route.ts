import {getChatGPTUser} from '../../chatgpt-auth';
import {relayMcpRequest} from '@/lib/server/mcp-relay';
import {createSecretStore} from '@/server/workspace-secrets.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  return relayMcpRequest(request, Boolean(user), (name, destination) => createSecretStore().resolve(user!.userId, name, destination));
}
