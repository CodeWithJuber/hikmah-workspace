import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore, CatalogStoreError } from '@/lib/catalog/store';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const STATUS: Record<string, number> = {
  'unknown-manifest': 404,
  'not-installed': 404,
  'manifest-revoked': 410,
  'regrant-required': 409,
  'signer-changed': 409,
  'bad-signature': 409,
  'version-not-increased': 409,
  'permissions-widened': 409,
  'unknown-permission': 400,
  'permission-not-requested': 403,
};

/** Move an install to a newer version. Applies the update policy (same key,
 * version increase, no silent permission widening): when the new version
 * requests permissions the old one did not, the body must explicitly
 * re-grant them, otherwise this returns 409 with the missing permissions. */
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
    return fail('Name the connector to update.', 400);
  if (body.grantedPermissions !== undefined && !Array.isArray(body.grantedPermissions))
    return fail('grantedPermissions must be an array of permission strings.', 400);
  try {
    const store = createCatalogStore(getStorage().raw);
    const row = store.get(body.name, typeof body.version === 'string' ? body.version : undefined);
    if (!row) return fail('That connector version is not in the catalog.', 404);
    const install = store.updateToVersion(
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
