import { getChatGPTUser } from '../../chatgpt-auth';
import { getStorage } from '@/server/storage.mjs';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { githubRequest } from '@/lib/github/connections-api';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  return githubRequest(request, {
    db: getStorage().raw,
    userId: (await getChatGPTUser())?.userId ?? null,
    secrets: createSecretStore(),
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
