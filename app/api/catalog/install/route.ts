import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore, CatalogStoreError } from '@/lib/catalog/store';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const STATUS: Record<string, number> = {
  'unknown-manifest': 404,
  'manifest-revoked': 410,
  'unknown-permission': 400,
  'permission-not-requested': 403,
};

/** Install a connector. The caller explicitly grants permissions: the body
 * names the subset of the manifest's requested permissions the user said
 * yes to. Granting nothing is allowed — the connector simply cannot run
 * until its required permissions are granted. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  let body: { name?: unknown; version?: unknown; grantedPermissions?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body.', 400);
  }
  if (typeof body.name !== 'string' || body.name.length === 0)
    return fail('Name the connector to install.', 400);
  if (body.grantedPermissions !== undefined && !Array.isArray(body.grantedPermissions))
    return fail('grantedPermissions must be an array of permission strings.', 400);
  try {
    const store = createCatalogStore(getStorage().raw);
    const row = store.get(body.name, typeof body.version === 'string' ? body.version : undefined);
    if (!row) return fail('That connector version is not in the catalog.', 404);
    const install = store.install(
      user.userId,
      row.id,
      (body.grantedPermissions ?? row.manifest.permissions) as string[],
    );
    return Response.json({ install }, { headers });
  } catch (error) {
    if (error instanceof CatalogStoreError) return fail(error.message, STATUS[error.code] ?? 400);
    return fail('The catalog is unavailable. Try again.', 503);
  }
}
