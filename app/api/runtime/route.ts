import { ownerIdentity } from '@/lib/kernel/server';
import { runtimeRelay } from '@/lib/server/runtime-relay';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let user;
  try {
    user = await ownerIdentity();
  } catch {
    return runtimeRelay(request, false);
  }
  const store = createSecretStore();
  return runtimeRelay(request, true, {
    token: () => store.resolve(user.userId, 'HIKMAH_RUNTIME_TOKEN', 'runtime', true),
    environmentNames: async () =>
      (await store.list(user.userId))
        .filter((row) => row.destination === 'runtime:env')
        .map((row) => row.name),
    environment: async () => {
      const names = (await store.list(user.userId)).filter(
        (row) => row.destination === 'runtime:env',
      );
      return Object.fromEntries(
        await Promise.all(
          names.map(async (row) => [
            row.name,
            await store.resolve(user.userId, row.name, 'runtime:env'),
          ]),
        ),
      );
    },
  });
}
export async function GET() {
  try {
    const user = await ownerIdentity();
    const hasSavedToken = (await createSecretStore().list(user.userId)).some(
      (row) => row.name === 'HIKMAH_RUNTIME_TOKEN' && row.destination === 'runtime',
    );
    return Response.json(
      {
        configured: Boolean(
          process.env.HIKMAH_RUNTIME_URL && (process.env.HIKMAH_RUNTIME_TOKEN || hasSavedToken),
        ),
      },
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch {
    return Response.json(
      { configured: false },
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
}
