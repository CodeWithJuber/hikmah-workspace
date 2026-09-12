import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { hostsRequest } from '@/lib/ssh/api';
import { credentialDestination, credentialName, type SshHostRow } from '@/lib/ssh/hosts';
import { sshExecStream } from '@/lib/ssh/client';
import { foldFrames, type RunFrame } from '@/lib/ssh/frames';
import { entitlementsForUser } from '@/lib/billing/server';

export const dynamic = 'force-dynamic';

/** How long a first connection may take before the owner is told it failed. */
const PROBE_TIMEOUT_MS = 20_000;

async function handle(request: Request) {
  const user = await getChatGPTUser();
  // Writes must carry our own Origin. A GET does not: browsers omit it on
  // same-origin GETs, so requiring it would break the list for everyone.
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request))
    return Response.json({ error: 'Use your signed-in workspace.' }, { status: 403 });

  const userId = user?.userId;
  // Checked here as well as inside, so the closures below can assume an owner.
  if (!userId)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401 });

  // Connections are made from the workbench, which is one container shared by
  // every account on the deployment. A host added here would be reached from
  // the operator's network with the operator's egress, so this stays theirs
  // until execution is per-tenant — the same rule the terminal and the run
  // tools follow.
  if (!entitlementsForUser({ userId, email: user.email }).execution)
    return Response.json(
      { error: 'SSH hosts are available to the workspace operator only.' },
      { status: 403 },
    );

  const storage = getStorage();
  const secrets = createSecretStore();

  return hostsRequest(request, {
    db: storage.raw,
    userId,
    saveCredential: (hostId, value) =>
      secrets.save(userId, {
        name: credentialName(hostId),
        destination: credentialDestination(hostId),
        value,
      }),
    removeCredential: (hostId) => secrets.remove(userId, credentialName(hostId)).catch(() => {}),
    probeHost: async (host: SshHostRow) => {
      const credential = await secrets.resolve(
        userId,
        credentialName(host.id),
        credentialDestination(host.id),
      );
      const frames: RunFrame[] = [];
      try {
        for await (const frame of sshExecStream(
          {
            // Deliberately no pinned fingerprint: this call exists to discover
            // one. Nothing is pinned until the owner confirms what came back.
            host: {
              id: host.id,
              host: host.host,
              port: host.port,
              username: host.username,
              credential:
                host.auth_kind === 'key'
                  ? { type: 'key', privateKey: credential }
                  : { type: 'password', password: credential },
            },
            // A no-op: the point is the handshake, not the command.
            command: 'true',
            timeoutMs: PROBE_TIMEOUT_MS,
          },
          { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        ))
          frames.push(frame);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Could not reach that host.' };
      }
      const result = foldFrames(frames);
      if (!result.fingerprint)
        return { error: result.error ?? 'That host did not complete an SSH handshake.' };
      return { fingerprint: result.fingerprint };
    },
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
