/** The saved-hosts API, as one function the route thinly wraps.
 *
 * Adding a host is deliberately three steps: save the details, connect once to
 * see the host key, and pin it only after the owner has read the fingerprint.
 * Pinning whatever answered the first connection would record an impostor just
 * as happily as the real server, so that first connection is treated as
 * untrusted by design and nothing is pinned without a human saying so.
 */
import { randomUUID } from 'node:crypto';
import {
  SshHostError,
  createHostStore,
  parseAutoApprove,
  parseHostInput,
  type SshHostRow,
} from './hosts.ts';
import type { SqliteHandle } from '../runs/store.ts';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Everything about a host except what would be needed to reach it. */
export function publicHost(row: SshHostRow) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authKind: row.auth_kind,
    fingerprint: row.fingerprint,
    autoApprove: parseAutoApprove(row.auto_approve),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export type HostsApiContext = {
  db: SqliteHandle;
  userId: string | undefined;
  /** Seals the credential against this host id. */
  saveCredential: (hostId: string, credential: string) => Promise<void>;
  removeCredential: (hostId: string) => Promise<void>;
  /** Connects once and reports the host key seen, without pinning it. */
  probeHost: (host: SshHostRow) => Promise<{ fingerprint?: string; error?: string }>;
  newId?: () => string;
};

/**
 * Handle one request against the saved hosts.
 *
 * The caller checks Origin on writes: a same-origin browser GET carries no
 * Origin header, so requiring one here would break the list.
 */
export async function hostsRequest(request: Request, context: HostsApiContext): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const store = createHostStore(context.db);
  const userId = context.userId;
  const listing = () => Response.json({ hosts: store.list(userId).map(publicHost) }, { headers });

  try {
    if (request.method === 'GET') return listing();

    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id') ?? '';
      if (!store.get(id, userId)) return fail('That host is not saved here.', 404);
      store.remove(id, userId);
      // A credential outliving its host would be a decryptable key with nothing
      // pointing at it and no way to remove it from the interface.
      await context.removeCredential(id);
      return listing();
    }

    if (request.method !== 'POST') return fail('Unsupported method.', 405);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return fail('Expected a JSON request body.', 400);
    const payload = body as Record<string, unknown>;
    const id = typeof payload.id === 'string' ? payload.id : '';

    // Step two: connect once and show the owner what answered.
    if (payload.action === 'probe') {
      const host = store.get(id, userId);
      if (!host) return fail('That host is not saved here.', 404);
      if (host.fingerprint)
        return Response.json({ fingerprint: host.fingerprint, pinned: true }, { headers });
      const probe = await context.probeHost(host);
      if (!probe.fingerprint) return fail(probe.error ?? 'Could not reach that host.', 502);
      return Response.json({ fingerprint: probe.fingerprint, pinned: false }, { headers });
    }

    // Step three: the owner has read the fingerprint and accepted it.
    if (payload.action === 'confirm') {
      const host = store.get(id, userId);
      if (!host) return fail('That host is not saved here.', 404);
      if (host.fingerprint)
        return fail(
          'This host is already pinned. Remove it and add it again to change its key.',
          409,
        );
      const fingerprint = payload.fingerprint;
      // Only a fingerprint this deployment just observed may be pinned, so a
      // stale or forged form post cannot pin an attacker's key.
      const probe = await context.probeHost(host);
      if (!probe.fingerprint) return fail(probe.error ?? 'Could not reach that host.', 502);
      if (typeof fingerprint !== 'string' || fingerprint !== probe.fingerprint)
        return fail(
          'The host key changed between being shown and being confirmed. Nothing was saved.',
          409,
        );
      if (!store.pinFingerprint(id, userId, probe.fingerprint))
        return fail('The fingerprint could not be recorded.', 409);
      return Response.json({ host: publicHost(store.get(id, userId)!) }, { headers });
    }

    // Step one: save the details and the credential.
    const input = parseHostInput(payload);
    const credential = payload.credential;
    if (typeof credential !== 'string' || !credential.trim())
      return fail('Enter the private key or password for this host.', 400);
    if (Buffer.byteLength(credential) > 8_000)
      return fail('That credential is larger than this workspace stores.', 413);

    const newId = (context.newId ?? (() => randomUUID().replace(/-/g, '')))();
    const created = store.create(newId, userId, input);
    try {
      await context.saveCredential(newId, credential);
    } catch (error) {
      // A host whose credential failed to save would look usable and fail on
      // every command, so it is rolled back rather than left behind.
      store.remove(newId, userId);
      throw error;
    }
    return Response.json({ host: publicHost(created) }, { status: 201, headers });
  } catch (error) {
    if (error instanceof SshHostError) return fail(error.message, error.status);
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : 'Could not update saved hosts.';
    return fail(message, typeof status === 'number' ? status : 400);
  }
}
