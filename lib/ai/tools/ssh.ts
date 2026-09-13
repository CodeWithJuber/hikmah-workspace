/** The assistant's SSH tool.
 *
 * The contract is deliberately narrow: a saved host id and a command. There is
 * no hostname parameter, no port, no username and no key path, because a model
 * following an instruction it read on a web page must not be able to construct a
 * connection to a machine the owner never saved.
 *
 * Approval is decided here, on the server, from the owner's own per-host list —
 * never from anything the model said about its own intentions.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { foldFrames, type CommandResult, type RunFrame } from '../../ssh/frames.ts';
import { sshExecStream, type SshCredential } from '../../ssh/client.ts';
import { isAutoApproved, parseAutoApprove, type SshHostRow } from '../../ssh/hosts.ts';

/** What the owner is shown on the approval card. */
export type SshApprovalRequest = { hostId: string; hostLabel: string; command: string };

/** Matches the workbench's own ceiling. */
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type SshToolContext = {
  /** The owner's saved hosts, already scoped to them. */
  listHosts: () => SshHostRow[] | Promise<SshHostRow[]>;
  /** Decrypts the credential for one call. */
  credentialFor: (host: SshHostRow) => Promise<SshCredential>;
  /** Records the fingerprint seen on a first connection. */
  pinFingerprint?: (hostId: string, fingerprint: string) => void | Promise<void>;
  /** Called for each output chunk, so the transcript fills in live. */
  onOutput?: (hostId: string, frame: RunFrame) => void;
  /** Records what was asked, decided and returned. */
  record?: (entry: {
    hostId: string;
    command: string;
    status: 'denied' | 'done' | 'failed';
    result?: CommandResult;
    autoApproved: boolean;
  }) => void | Promise<void>;
  signal: AbortSignal;
  stream?: typeof sshExecStream;
};

/** What the model is told about a run, in words rather than raw frames. */
export function describeResult(result: CommandResult): string {
  if (result.hostKeyChanged) return result.error!;
  if (result.error) return result.error;
  const parts: string[] = [];
  parts.push(result.exitCode === 0 ? 'Exit code 0.' : `Exit code ${result.exitCode ?? 'unknown'}.`);
  if (result.truncated)
    parts.push('Output was longer than the inline limit and has been cut off at the end.');
  return parts.join(' ');
}

export function sshTools(context: SshToolContext) {
  const stream = context.stream ?? sshExecStream;

  return {
    ssh_exec: tool({
      description:
        'Run one shell command on a server the owner has saved, over SSH. Use list_ssh_hosts first to find the host_id; you cannot connect to a host the owner has not saved, and you cannot supply a hostname, port, username or key. Commands the owner has not pre-approved will pause for their approval, so explain in `description` what the command does and why. Output longer than about 30,000 characters is cut off.',
      inputSchema: z.object({
        host_id: z.string().min(1).max(64).describe('The id of a saved host, from list_ssh_hosts.'),
        command: z.string().min(1).max(8_000).describe('The exact command to run.'),
        description: z
          .string()
          .min(1)
          .max(200)
          .describe('One line, for the owner: what this does and why. Shown on the approval card.'),
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`How long to allow, in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      }),
      execute: async ({ host_id, command, timeout_ms }) => {
        const hosts = await context.listHosts();
        const host = hosts.find((entry) => entry.id === host_id);
        // Naming an unknown host is the expected outcome of a redirected
        // instruction, so the list of real ones comes back with the refusal.
        if (!host)
          return {
            ok: false as const,
            error: `No saved host with id ${host_id}. Saved hosts: ${
              hosts.map((entry) => `${entry.id} (${entry.name})`).join(', ') || 'none'
            }.`,
          };

        // Approval has already happened by the time execute runs: the policy
        // below is what paused the run and asked. Reaching here means either the
        // owner said yes or their own list said this command is fine.
        const label = `${host.name} (${host.username}@${host.host}:${host.port})`;
        const autoApproved = isAutoApproved(command, parseAutoApprove(host.auto_approve));

        const frames: RunFrame[] = [];
        try {
          for await (const frame of stream(
            {
              host: {
                id: host.id,
                host: host.host,
                port: host.port,
                username: host.username,
                credential: await context.credentialFor(host),
                fingerprint: host.fingerprint ?? undefined,
              },
              command,
              timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
            },
            { signal: context.signal },
          )) {
            frames.push(frame);
            context.onOutput?.(host.id, frame);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The command could not be run.';
          await context.record?.({ hostId: host.id, command, status: 'failed', autoApproved });
          return { ok: false as const, error: message };
        }

        const result = foldFrames(frames);
        // A host is pinned the first time it is reached, and only then: the
        // store refuses to overwrite an existing pin.
        if (result.fingerprint && !host.fingerprint)
          await context.pinFingerprint?.(host.id, result.fingerprint);
        await context.record?.({
          hostId: host.id,
          command,
          status: result.error ? 'failed' : 'done',
          result,
          autoApproved,
        });

        return {
          ok: !result.error,
          host: label,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          summary: describeResult(result),
        };
      },
    }),

    list_ssh_hosts: tool({
      description:
        'List the servers the owner has saved, with the id to pass to ssh_exec. Returns nothing about credentials.',
      inputSchema: z.object({}),
      execute: async () => {
        const hosts = await context.listHosts();
        return {
          hosts: hosts.map((host) => ({
            id: host.id,
            name: host.name,
            target: `${host.username}@${host.host}:${host.port}`,
            pinned: Boolean(host.fingerprint),
            autoApproved: parseAutoApprove(host.auto_approve),
          })),
        };
      },
    }),
  };
}

/**
 * Which SSH calls need the owner's say-so.
 *
 * Expressed as the AI SDK's tool-approval policy rather than as a question
 * inside `execute`, because pausing a run and asking a person is something the
 * framework can do and a tool body cannot: by the time execute runs there is
 * nobody listening.
 *
 * Anything not on the owner's own per-host list asks. A host the model invented
 * is approved here and refused inside the tool, where the refusal can explain
 * itself and list the real hosts.
 */
export function sshApprovalPolicy(context: {
  listHosts: () => SshHostRow[] | Promise<SshHostRow[]>;
  /** Tools the owner has granted, from the card: ssh_exec here means every
   * host, on top of each host's own allowlist. */
  grants?: { tools: Set<string> };
}) {
  return async (raw: unknown) => {
    const input = (raw ?? {}) as { host_id?: unknown; command?: unknown };
    // Anything this cannot read is asked about rather than assumed safe.
    if (typeof input.host_id !== 'string' || typeof input.command !== 'string')
      return 'user-approval' as const;
    if (context.grants?.tools.has('ssh_exec')) return 'approved' as const;
    const host = (await context.listHosts()).find((entry) => entry.id === input.host_id);
    if (!host) return 'approved' as const;
    return isAutoApproved(input.command, parseAutoApprove(host.auto_approve))
      ? ('approved' as const)
      : ('user-approval' as const);
  };
}
