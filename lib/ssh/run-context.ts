/** Wiring the SSH tool to this deployment's storage and secrets.
 *
 * Kept out of `lib/ai/tools/ssh.ts` so that module stays testable without a
 * database, and out of `lib/runs/service.ts` so the worker does not need to know
 * how a credential is sealed.
 */
import { getStorage } from '../../server/storage.mjs';
import { createSecretStore } from '../../server/workspace-secrets.mjs';
import { workbenchConfig } from './client.ts';
import { createHostStore, credentialDestination, credentialName } from './hosts.ts';
import type { SshToolContext } from '../ai/tools/ssh.ts';

/**
 * Build the tool context for one owner, or nothing when this deployment has no
 * workbench. Returning nothing is what keeps ssh_exec out of the tool set
 * entirely, rather than offering a tool that fails on every call.
 */
export function sshRunContext(userId: string): Omit<SshToolContext, 'signal'> | undefined {
  try {
    workbenchConfig();
  } catch {
    return undefined;
  }

  const store = createHostStore(getStorage().raw);
  const secrets = createSecretStore();
  return {
    listHosts: () => store.list(userId),
    credentialFor: async (host) => {
      const value = await secrets.resolve(
        userId,
        credentialName(host.id),
        credentialDestination(host.id),
      );
      return host.auth_kind === 'key'
        ? { type: 'key', privateKey: value }
        : { type: 'password', password: value };
    },
    pinFingerprint: (hostId, fingerprint) => {
      store.pinFingerprint(hostId, userId, fingerprint);
    },
    record: ({ hostId }) => {
      store.markUsed(hostId);
    },
  };
}
