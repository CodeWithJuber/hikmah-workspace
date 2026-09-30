import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore, CatalogStoreError } from '@/lib/catalog/store';
import { requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Revoke a connector version. Owner only.
 *
 * Revocation deactivates; it never deletes. The manifest row, its signature
 * and every install stay in the database: existing installs keep working,
 * new installs are refused, and the UI shows the revoked state honestly.
 * There is no un-revoke: a revoked version stays revoked, which is what
 * makes revocation trustworthy as a safety control. */
export async function POST(request: Request) {
  try {
    await requirePermission('users:manage');
  } catch (error) {
    if (error instanceof KernelHttpError)
      return fail(
        error.status === 401
          ? 'Sign in to your private workspace.'
          : 'Only the workspace owner can revoke a connector.',
        error.status,
      );
    return fail('Only the workspace owner can revoke a connector.', 403);
  }
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  let body: { name?: unknown; version?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body.', 400);
  }
  if (typeof body.name !== 'string' || typeof body.version !== 'string')
    return fail('Name the connector and version to revoke.', 400);
  try {
    const store = createCatalogStore(getStorage().raw);
    const revoked = store.revoke(`${body.name}@${body.version}`);
    return Response.json(
      {
        revoked: {
          id: revoked.id,
          name: revoked.manifest.name,
          version: revoked.manifest.version,
          status: revoked.status,
        },
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof CatalogStoreError)
      return fail(error.message, error.code === 'unknown-manifest' ? 404 : 400);
    return fail('The catalog is unavailable. Try again.', 503);
  }
}
