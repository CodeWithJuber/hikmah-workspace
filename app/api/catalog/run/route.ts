import { resolve } from 'node:path';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createCatalogStore } from '@/lib/catalog/store';
import { connectorFor } from '@/lib/catalog/registry';
import { mayRunInstall } from '@/lib/catalog/updates';
import { verifySignedManifest } from '@/lib/catalog/signing';
import type { ConnectorContext } from '@/lib/catalog/connector';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const dataDir = () => process.env.HIKMAH_DATA_DIR || resolve('.data');

/** Run an installed connector.
 *
 * Three gates, in order: the caller must have the connector installed; the
 * install must have granted every permission the connector requires; and the
 * manifest's signature must still verify. A revoked install keeps working
 * here — revocation refuses new installs, it does not brick existing ones —
 * but the response says so honestly.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);
  let body: { name?: unknown; input?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body.', 400);
  }
  if (typeof body.name !== 'string' || body.name.length === 0)
    return fail('Name the connector to run.', 400);
  try {
    const store = createCatalogStore(getStorage().raw);
    const install = store
      .installsFor(user.userId)
      .find((i) => i.manifest.manifest.name === body.name);
    if (!install) return fail('Install this connector before running it.', 404);
    if (!mayRunInstall(install.manifest))
      return fail('This connector version can no longer run.', 410);
    if (!verifySignedManifest(install.manifest))
      return fail('The installed manifest no longer verifies. Reinstall it.', 409);
    const connector = connectorFor(install.manifest.manifest.entrypoint);
    if (!connector)
      return fail(
        'This connector is listed and installed, but the catalog ships no reviewed implementation for it, so it cannot run here.',
        501,
      );
    const missing = connector.requiredPermissions.filter(
      (p) => !install.grantedPermissions.includes(p),
    );
    if (missing.length)
      return fail(
        `This run needs ${missing.join(', ')}, which the install did not grant. Grant ${missing.length === 1 ? 'it' : 'them'} first.`,
        403,
      );
    const ctx: ConnectorContext = {
      grantedPermissions: install.grantedPermissions,
      notesDir: process.env.CATALOG_NOTES_DIR || resolve(dataDir(), 'notes'),
      allowedDir: process.env.CATALOG_FILES_DIR || resolve(dataDir(), 'connector-files'),
    };
    const result = await connector.run(body.input ?? {}, ctx);
    if (!result.ok)
      return Response.json({ error: result.error, code: result.code }, { status: 422, headers });
    return Response.json(
      {
        result: result.data,
        revoked: install.manifest.status === 'revoked',
      },
      { headers },
    );
  } catch {
    return fail('The connector run failed. Try again.', 503);
  }
}
