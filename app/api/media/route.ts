import { getChatGPTUser } from '../../chatgpt-auth';
import { relayMediaRequest } from '@/lib/server/media-relay';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return relayMediaRequest(request, Boolean(user), (name, destination) =>
    createSecretStore().resolve(user!.userId, name, destination),
  );
}
export const GET = handle;
export const POST = handle;
