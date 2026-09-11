/** Running commands in the workbench container.
 *
 * `ssh_exec` reaches a machine the owner saved; this runs here, in the sidecar,
 * on the workspace volume. That distinction matters to the person approving it,
 * so it is in the tool description and on the approval card rather than only in
 * this comment: a command here has network access and can read anything the
 * shell user can. The container boundary is the sandbox, not a jail.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { foldFrames, type CommandResult, type RunFrame } from '../../ssh/frames.ts';
import { workbenchStream } from '../../ssh/client.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Commands that only look. Matched on the first word, because these are about
 * what a command *is*, not what its arguments say — and any command carrying a
 * separator is excluded before this is consulted.
 */
export const READ_ONLY_COMMANDS = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'find',
  'grep',
  'rg',
  'tree',
  'du',
  'df',
  'date',
  'whoami',
  'env',
  'which',
  'echo',
  'diff',
];

/** Characters that turn one command into several, or redirect its output. */
const SEPARATORS = /[;&|`$><\n\r\\]/;

/**
 * May this command run without asking?
 *
 * Deliberately narrow. A shell command is not a safe thing by default, and the
 * cost of a wrong "yes" here is arbitrary code in the owner's workspace, so
 * anything with a separator, a flag that writes, or an unrecognised name asks.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SEPARATORS.test(trimmed)) return false;
  const [name] = trimmed.split(/\s+/);
  return READ_ONLY_COMMANDS.includes(name);
}

export type ShellToolContext = {
  /** Groups commands into one shell session, so `cd` carries between calls. */
  conversationId: string;
  /** True when this deployment has a workbench to run them in. */
  available: boolean;
  onOutput?: (frame: RunFrame) => void;
  signal: AbortSignal;
  /** Injected by the tests. */
  stream?: typeof workbenchStream;
};

function summarise(result: CommandResult & { timedOut?: boolean; logPath?: string }): string {
  const parts: string[] = [];
  if (result.error) return result.error;
  if (result.timedOut) parts.push('The command ran out of time and was stopped.');
  parts.push(result.exitCode === 0 ? 'Exit code 0.' : `Exit code ${result.exitCode ?? 'unknown'}.`);
  if (result.truncated)
    parts.push(
      result.logPath
        ? `Output was cut off; the whole of it is in ${result.logPath}.`
        : 'Output was cut off at the inline limit.',
    );
  return parts.join(' ');
}

export function shellTools(context: ShellToolContext) {
  const stream = context.stream ?? workbenchStream;

  const execute = async (request: Record<string, unknown>) => {
    const frames: RunFrame[] = [];
    try {
      for await (const frame of stream(
        { ...request, sessionId: context.conversationId },
        { signal: context.signal },
      )) {
        frames.push(frame);
        context.onOutput?.(frame);
      }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'The command could not be run.',
      };
    }

    const exit = frames.find((frame) => frame.type === 'exit') as
      { cwd?: string; timedOut?: boolean; logPath?: string } | undefined;
    const result = { ...foldFrames(frames), ...exit };
    return {
      ok: !result.error && result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
      cwd: exit?.cwd,
      summary: summarise(result),
    };
  };

  return {
    bash: tool({
      description:
        'Run a shell command in the workspace container. This is not the owner’s own machine and not a saved SSH host: it is a sidecar with a persistent /workspace volume, network access, and no route to the app’s database or secrets. The working directory carries between calls in one conversation, so `cd` then `ls` works. Commands that only read are run straight away; anything else pauses for the owner, so say in `description` what it does and why. Output beyond about 30,000 characters is cut off and written to a log file whose path comes back.',
      inputSchema: z.object({
        command: z.string().min(1).max(8_000).describe('The exact shell command to run.'),
        description: z
          .string()
          .min(1)
          .max(200)
          .describe('One line, for the owner: what this does and why. Shown on the approval card.'),
        reset: z
          .boolean()
          .optional()
          .describe('Start again at the top of the workspace, forgetting the current directory.'),
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`How long to allow, in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      }),
      execute: ({ command, reset, timeout_ms }) =>
        execute({ tool: 'bash', command, reset, timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS }),
    }),

    sandbox_run: tool({
      description:
        'Run a short Python or Node program in the workspace container. Use this instead of bash when you are computing something rather than operating on the machine: the code goes in as a file, so you never have to quote it for a shell.',
      inputSchema: z.object({
        language: z.enum(['python', 'node']).describe('Which interpreter to use.'),
        code: z.string().min(1).max(100_000).describe('The program to run.'),
        description: z
          .string()
          .min(1)
          .max(200)
          .describe('One line, for the owner: what this computes and why.'),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      }),
      execute: ({ language, code, timeout_ms }) =>
        execute({
          tool: 'sandbox_run',
          language,
          code,
          timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        }),
    }),
  };
}

/**
 * Which shell calls need the owner's say-so.
 *
 * A read-only command runs straight away; everything else pauses. `sandbox_run`
 * always pauses, because a program is not something anyone can skim the way they
 * can skim `ls -la`.
 */
export function shellApprovalPolicy() {
  return (raw: unknown) => {
    const input = (raw ?? {}) as { command?: unknown };
    if (typeof input.command !== 'string') return 'user-approval' as const;
    return isReadOnlyCommand(input.command) ? ('approved' as const) : ('user-approval' as const);
  };
}
