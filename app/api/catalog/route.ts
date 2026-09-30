import { getChatGPTUser } from '../../chatgpt-auth';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore } from '@/lib/catalog/store';
import { verifySignedManifest } from '@/lib/catalog/signing';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** The catalog: every installable connector plus the caller's installs.
 *
 * Browse shows only active (or deprecated) manifests — revoked ones never
 * appear here. The caller's installs are listed separately so a revoked
 * install still shows, honestly badged, and keeps working.
 */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    const store = createCatalogStore(getStorage().raw);
    const updates = new Map(store.updateCheck(user.userId).map((u) => [u.name, u]));
    const connectors = store.listActive().map((row) => {
      const update = updates.get(row.manifest.name);
      return {
        id: row.id,
        name: row.manifest.name,
        version: row.manifest.version,
        description: row.manifest.description,
        permissions: row.manifest.permissions,
        entrypoint: row.manifest.entrypoint,
        homepage: row.manifest.homepage ?? null,
        status: row.status,
        signatureValid: verifySignedManifest(row),
        signer: row.signer,
        updateAvailable: update !== undefined,
        latestVersion: update?.latestVersion ?? row.manifest.version,
      };
    });
    const installs = store.installsFor(user.userId).map((install) => ({
      manifestId: install.manifestId,
      name: install.manifest.manifest.name,
      version: install.manifest.manifest.version,
      status: install.manifest.status,
      grantedPermissions: install.grantedPermissions,
      installedAt: install.installedAt,
      signatureValid: verifySignedManifest(install.manifest),
      updateAvailable: updates.has(install.manifest.manifest.name),
      latestVersion:
        updates.get(install.manifest.manifest.name)?.latestVersion ??
        install.manifest.manifest.version,
      needsRegrant: updates.get(install.manifest.manifest.name)?.needsRegrant ?? false,
      permissionsAdded: updates.get(install.manifest.manifest.name)?.permissionsAdded ?? [],
    }));
    return Response.json({ connectors, installs }, { headers });
  } catch {
    return fail('The catalog is unavailable. Try again.', 503);
  }
}
