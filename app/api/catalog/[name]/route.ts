import { getChatGPTUser } from '../../../chatgpt-auth';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore } from '@/lib/catalog/store';
import { verifySignedManifest, fingerprint } from '@/lib/catalog/signing';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** One connector: its latest manifest, every version with its status, and
 * the caller's install state. Versions are shown with their status so a
 * revoked version is visible, not hidden. */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const { name } = await params;
  try {
    const store = createCatalogStore(getStorage().raw);
    const versions = store.versions(name);
    if (!versions.length) return fail('That connector is not in the catalog.', 404);
    const current = versions.find((v) => v.status !== 'revoked') ?? versions[0];
    const install =
      store.installsFor(user.userId).find((i) => i.manifest.manifest.name === name) ?? null;
    return Response.json(
      {
        manifest: {
          ...current.manifest,
          id: current.id,
          status: current.status,
          signature: current.signature,
          signer: current.signer,
          signerFingerprint: fingerprint(current.signer),
          signatureValid: verifySignedManifest(current),
        },
        versions: versions.map((v) => ({
          id: v.id,
          version: v.manifest.version,
          status: v.status,
        })),
        installed: install
          ? {
              manifestId: install.manifestId,
              version: install.manifest.manifest.version,
              status: install.manifest.status,
              grantedPermissions: install.grantedPermissions,
              installedAt: install.installedAt,
            }
          : null,
      },
      { headers },
    );
  } catch {
    return fail('The catalog is unavailable. Try again.', 503);
  }
}
