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
import { commandGranted, type ResolvedGrants } from '../../chat/approvals.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Commands that only look. These are the keys of READ_POLICIES below: a name
 * earns its place by reading, and then every argument it is given is checked
 * against explicitly permitted forms — because a read with the wrong flags is
 * an execution wearing a costume (`find`'s `-exec`, `tree`'s `-o`,
 * `date`'s `-s`).
 *
 * (The list itself is derived from the policy table below, so the two cannot
 * drift apart.)
 */

/** Characters that turn one command into several, or redirect its output. */
const SEPARATORS = /[;&|`$><\n\r\\]/;

/**
 * Split a command on whitespace, honouring single and double quotes.
 *
 * Backslash cannot appear here — it is a separator, rejected before this runs —
 * so there are no escapes to interpret. Returns null on an unbalanced quote:
 * an ambiguous command asks rather than being guessed at.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

/**
 * One command's explicitly permitted argument forms.
 *
 * The deny lists are the execution/write hooks: subprocess spawning, file
 * writes, network use, environment mutation. Those always require the intended
 * explicit grant — a read grant never covers them, even when the command name
 * does. Anything not listed anywhere (an unknown flag, a malformed value) is
 * not silently allowed: the policy answers "ask".
 */
interface ReadCommandPolicy {
  /** Boolean short flags, usable in bundles: `-la`. */
  shortFlags: string;
  /** Short flags taking a value, glued (`-n5`) or separate (`-n 5`). */
  shortValueFlags: string;
  /** Boolean long flags: `--all`. */
  longFlags: string[];
  /** Long flags taking `=value` or a following token: `--sort=time`. */
  longValueFlags: string[];
  /** Short flags that execute or write: never covered by the read grant. */
  deniedShort: string;
  /** Long flags that execute or write: never covered by the read grant. */
  deniedLong: string[];
  /** Allow the obsolete `-NUM` form (`head -20`). */
  obsoleteCount?: boolean;
  /** Decide the argument list some other way (for `find`'s little language). */
  custom?: (args: string[]) => boolean;
}

const NO_POLICY_EXTRAS = {
  shortValueFlags: '',
  longFlags: [] as string[],
  longValueFlags: [] as string[],
  deniedShort: '',
  deniedLong: [] as string[],
};

const READ_POLICIES: Record<string, ReadCommandPolicy> = {
  ls: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'aAbBcCdDfFgGhHiIklLmnNopqQrRsStTuUvVxXZ1D0',
    shortValueFlags: 'Tw',
    longFlags: [
      'all',
      'almost-all',
      'escape',
      'directory',
      'dired',
      'file-type',
      'full-time',
      'group-directories-first',
      'human-readable',
      'inode',
      'literal',
      'no-group',
      'numeric-uids',
      'reverse',
      'recursive',
      'size',
      'classify',
      'dereference-command-line',
      'dereference-command-line-symlink-to-dir',
      'zero',
      'context',
    ],
    longValueFlags: [
      'sort',
      'time',
      'time-style',
      'color',
      'indicator-style',
      'quoting-style',
      'format',
      'hide',
      'ignore',
      'width',
      'tabsize',
      'block-size',
    ],
  },
  pwd: { ...NO_POLICY_EXTRAS, shortFlags: 'LP', longFlags: ['logical', 'physical'] },
  cat: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'nbsAETevtu',
    longFlags: [
      'number',
      'number-nonblank',
      'squeeze-blank',
      'show-all',
      'show-ends',
      'show-tabs',
      'show-nonprinting',
    ],
  },
  head: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'qvz',
    shortValueFlags: 'nc',
    obsoleteCount: true,
    longFlags: ['quiet', 'verbose', 'zero-terminated'],
    longValueFlags: ['lines', 'bytes'],
  },
  tail: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'qvFfz',
    shortValueFlags: 'nc',
    obsoleteCount: true,
    longFlags: ['quiet', 'verbose', 'follow', 'retry', 'zero-terminated'],
    longValueFlags: ['lines', 'bytes', 'pid', 'sleep-interval'],
  },
  wc: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'cmlwL',
    longFlags: ['bytes', 'chars', 'lines', 'words', 'max-line-length'],
    longValueFlags: ['files0-from'],
  },
  file: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'bikhL',
    deniedShort: 'z', // --uncompress: decompresses (and so runs decoders on) the target
    longFlags: [
      'brief',
      'mime',
      'mime-type',
      'mime-encoding',
      'dereference',
      'keep-going',
      'no-pad',
    ],
    longValueFlags: ['files-from', 'separator', 'exclude'],
    deniedLong: ['uncompress'],
  },
  stat: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'fLt',
    longFlags: ['filesystem', 'dereference', 'terse', 'strip-trailing-cr'],
    longValueFlags: ['printf', 'format'],
  },
  grep: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'rivnclLhoqswxFEPzabH',
    shortValueFlags: 'efmABCdD',
    longFlags: [
      'recursive',
      'dereference-recursive',
      'ignore-case',
      'invert-match',
      'line-number',
      'count',
      'files-with-matches',
      'files-without-match',
      'no-filename',
      'with-filename',
      'only-matching',
      'quiet',
      'silent',
      'no-messages',
      'word-regexp',
      'line-regexp',
      'fixed-strings',
      'extended-regexp',
      'perl-regexp',
      'basic-regexp',
      'text',
      'null',
      'null-data',
      'line-buffered',
      'unix-byte-offsets',
      'mmap',
    ],
    longValueFlags: [
      'regexp',
      'file',
      'max-count',
      'after-context',
      'before-context',
      'context',
      'include',
      'exclude',
      'exclude-dir',
      'exclude-from',
      'label',
      'devices',
      'directories',
      'binary-files',
      'color',
    ],
  },
  rg: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'ivnlLohqswxFzabHp',
    shortValueFlags: 'efgtmABCM',
    // --pre runs a preprocessor program over every searched file: subprocess
    // spawning, so it needs the explicit grant, never the read grant.
    deniedLong: ['pre', 'pre-glob'],
    longFlags: [
      'ignore-case',
      'invert-match',
      'line-number',
      'files-with-matches',
      'files-without-match',
      'no-filename',
      'with-filename',
      'only-matching',
      'quiet',
      'word-regexp',
      'line-regexp',
      'fixed-strings',
      'hidden',
      'no-ignore',
      'follow',
      'smart-case',
      'text',
      'null',
      'null-data',
      'line-buffered',
      'no-messages',
      'vimgrep',
      'stats',
      'heading',
      'no-heading',
      'break',
      'no-break',
      'multiline',
      'pretty',
    ],
    longValueFlags: [
      'regexp',
      'file',
      'glob',
      'iglob',
      'type',
      'type-add',
      'max-count',
      'after-context',
      'before-context',
      'context',
      'max-columns',
      'color',
      'engine',
      'dfa-size-limit',
    ],
  },
  tree: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'adfiNClpughsD',
    shortValueFlags: 'LPI',
    deniedShort: 'o', // --output-file: writes the listing to a file
    longFlags: ['all', 'dirs-only', 'full-path'],
    longValueFlags: ['level', 'pattern'],
    deniedLong: ['output-file'],
  },
  du: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'shcaxLSbkS0',
    shortValueFlags: 'd',
    longFlags: [
      'summarize',
      'human-readable',
      'si',
      'total',
      'all',
      'one-file-system',
      'dereference',
      'dereference-args',
      'bytes',
      'apparent-size',
      'separate-dirs',
      'null',
    ],
    longValueFlags: ['max-depth', 'block-size', 'threshold', 'time', 'time-style', 'exclude'],
  },
  df: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'hHkmiTP',
    longFlags: ['human-readable', 'si', 'print-type', 'inodes', 'portability', 'local'],
    longValueFlags: ['block-size', 'output', 'type', 'exclude-type'],
  },
  date: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'u',
    shortValueFlags: 'r', // -r: show a file's mtime — still a read
    deniedShort: 's', // --set: moves the machine's clock
    longFlags: ['utc'],
    longValueFlags: ['date', 'iso-8601', 'rfc-3339', 'rfc-email'],
    deniedLong: ['set'],
  },
  whoami: { ...NO_POLICY_EXTRAS, shortFlags: '' },
  which: { ...NO_POLICY_EXTRAS, shortFlags: 'a', longFlags: ['all'] },
  echo: { ...NO_POLICY_EXTRAS, shortFlags: 'neE' },
  diff: {
    ...NO_POLICY_EXTRAS,
    shortFlags: 'rqbBiwtTyucenpsaN',
    shortValueFlags: 'DFILU',
    longFlags: [
      'recursive',
      'brief',
      'ed',
      'normal',
      'rcs',
      'side-by-side',
      'report-identical-files',
      'ignore-case',
      'ignore-all-space',
      'ignore-blank-lines',
      'ignore-space-change',
      'ignore-tab-expansion',
      'text',
      'new-file',
      'unidirectional-new-file',
      'minimal',
      'speed-large-files',
      'strip-trailing-cr',
      'show-c-function',
    ],
    longValueFlags: [
      'unified',
      'context',
      'ifdef',
      'ignore-matching-lines',
      'show-function-line',
      'label',
      'from-file',
      'to-file',
    ],
  },
  find: { ...NO_POLICY_EXTRAS, shortFlags: '', custom: findExpressionOk },
};

/** The allowlisted command names, derived from the policy table above. */
export const READ_ONLY_COMMANDS = Object.keys(READ_POLICIES);

/**
 * `find` earns its place on the list by reading, but its arguments are a
 * language of tests and actions — and `-delete`, `-exec`, `-ok` and friends
 * delete trees and run arbitrary commands without needing any separator.
 * GNU find also accepts unambiguous abbreviations, so `-del` deletes too.
 *
 * Matched per token, not as a substring, so a file named `deleted` is not an
 * action and `-name -delete` is a pattern, not a deletion.
 */
const FIND_DENIED_ACTIONS = [
  'delete',
  'exec',
  'execdir',
  'ok',
  'okdir',
  'fls',
  'fprint',
  'fprint0',
  'fprintf',
];

/** Predicates taking a value: the next token is data, whatever it looks like. */
const FIND_VALUE_OPTS = new Map<string, number>([
  ['maxdepth', 1],
  ['mindepth', 1],
  ['regextype', 1],
  ['D', 1],
  ['O', 1],
  ['name', 1],
  ['iname', 1],
  ['lname', 1],
  ['ilname', 1],
  ['path', 1],
  ['ipath', 1],
  ['regex', 1],
  ['iregex', 1],
  ['type', 1],
  ['size', 1],
  ['perm', 1],
  ['user', 1],
  ['group', 1],
  ['uid', 1],
  ['gid', 1],
  ['atime', 1],
  ['mtime', 1],
  ['ctime', 1],
  ['amin', 1],
  ['mmin', 1],
  ['cmin', 1],
  ['newer', 1],
  ['anewer', 1],
  ['cnewer', 1],
  ['mnewer', 1],
  ['newerXY', 1],
  ['links', 1],
  ['samefile', 1],
  ['used', 1],
  ['printf', 1],
]);

/** Predicates taking no value: global options, tests, operators, safe actions. */
const FIND_BARE_OPTS = new Set([
  'xdev',
  'daystart',
  'warn',
  'nowarn',
  'P',
  'H',
  'L',
  'empty',
  'depth',
  'true',
  'false',
  'readable',
  'writable',
  'executable',
  'prune',
  'nouser',
  'nogroup',
  'and',
  'or',
  'not',
  'a',
  'o',
  'print',
  'print0',
  'ls',
  'quit',
]);

function findExpressionOk(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const token = args[i++];
    if (token === '(' || token === ')' || token === '!' || token === ',') continue;
    if (!token.startsWith('-') || token === '-') continue; // a path, or the stdin marker
    const word = token.slice(1);
    // Denied actions, including their unambiguous abbreviations: `-del`
    // deletes exactly like `-delete` does.
    if (word.length >= 2 && FIND_DENIED_ACTIONS.some((action) => action.startsWith(word)))
      return false;
    const arity = FIND_VALUE_OPTS.get(word);
    if (arity !== undefined) {
      if (i + arity > args.length) return false; // a value-taking predicate with no value
      i += arity;
      continue;
    }
    if (FIND_BARE_OPTS.has(word)) continue;
    return false; // an unknown predicate asks rather than being assumed safe
  }
  return true;
}

/** Check one argument list against its command's permitted forms. */
function argsOk(policy: ReadCommandPolicy, args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') return true; // everything after is a positional operand
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const hasValue = eq !== -1;
      if (!name || policy.deniedLong.includes(name)) return false;
      if (policy.longValueFlags.includes(name)) {
        if (!hasValue && ++i >= args.length) return false; // value missing
        continue;
      }
      if (hasValue || !policy.longFlags.includes(name)) return false;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      if (policy.obsoleteCount && /^-\d+$/.test(token)) continue;
      let j = 1;
      while (j < token.length) {
        const flag = token[j];
        if (policy.deniedShort.includes(flag)) return false;
        if (policy.shortValueFlags.includes(flag)) {
          if (j + 1 === token.length && ++i >= args.length) return false; // value missing
          break; // the rest of the token (or the next one) is the value
        }
        if (!policy.shortFlags.includes(flag)) return false;
        j++;
      }
      continue;
    }
    // A positional operand: a path, a pattern, a date format. It cannot smuggle
    // environment — a leading `VAR=value` would be the command name, which is
    // never allowlisted, and `$` interpolation is a separator, rejected above.
  }
  return true;
}

/**
 * What "read-only" assumes about the world around the command.
 *
 * The checks above see only the command string. Environment variables, config
 * files and aliases can change what a command does — `BASH_ENV` points a
 * non-interactive bash at a startup file, `ENV` does the same for sh, and a
 * login shell sources profile files that may define functions shadowing `ls`.
 * The policy accounts for this in three ways:
 *
 * 1. The command string cannot smuggle environment in: a leading `VAR=value`
 *    is the command name and never allowlisted; `$` interpolation (and with
 *    it `$(...)` and backticks) is a separator and always asks.
 * 2. Auto-approval is only meaningful where the runner scrubs the ambient
 *    environment (the workbench's `commandEnvironment` allowlist: `BASH_ENV`,
 *    `ENV`, `CDPATH` and friends never cross) and runs non-interactively, so
 *    aliases are not expanded. The fixtures pin both halves of this contract.
 * 3. Known residual, stated plainly: the workbench runs commands with
 *    `bash -lc` — a login shell sources `/etc/profile` and `~/.bash_profile`,
 *    which can define functions shadowing allowlisted names. Closing that is
 *    the runner's job, not this policy's; until it does, the approval card
 *    still shows the exact command, and anything with a metacharacter asks.
 */

/**
 * May this command run without asking?
 *
 * Deliberately narrow. A shell command is not a safe thing by default, and the
 * cost of a wrong "yes" here is arbitrary code in the owner's workspace, so
 * anything with a separator, a flag that writes or executes, or an
 * unrecognised name or argument form asks.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SEPARATORS.test(trimmed)) return false;
  const tokens = tokenize(trimmed);
  if (!tokens) return false;
  const [name, ...args] = tokens;
  const policy = READ_POLICIES[name];
  if (!policy) return false;
  return policy.custom ? policy.custom(args) : argsOk(policy, args);
}

export type ShellToolContext = {
  /** Groups commands into one shell session, so `cd` carries between calls. */
  conversationId: string;
  /** Which account this runs as, in the workbench: an opaque HMAC, not the user
   * id. The workbench resolves it to a Unix user and a directory, and refuses a
   * request that carries none — there is no shared slot to fall back to. */
  userKey: string;
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
        { ...request, sessionId: context.conversationId, userKey: context.userKey },
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
        'Run a shell command in the workspace container. This is not the owner’s own machine and not a saved SSH host: it is a sidecar with a persistent /workspace volume, network access, and no route to the app’s database or secrets. The working directory carries between calls in one conversation, so `cd` then `ls` works. Commands that only read are run straight away; anything else pauses for the owner, so say in `description` what it does and why. Output beyond about 30,000 characters is cut off and written to a log file whose path comes back. For a plain file read or directory listing of the owner’s workspace files, prefer the read_file / list_files tools — they never need approval. Use bash when you need search (grep), file metadata, or command output.',
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
export function shellApprovalPolicy(grants?: ResolvedGrants) {
  return (raw: unknown) => {
    const input = (raw ?? {}) as { command?: unknown };
    if (typeof input.command !== 'string') return 'user-approval' as const;
    // What the owner has already said yes to: the tool anywhere or in this
    // conversation, or this command by name. Read-only commands never asked.
    if (grants?.tools.has('bash')) return 'approved' as const;
    if (isReadOnlyCommand(input.command)) return 'approved' as const;
    if (grants && commandGranted(input.command, grants.commands)) return 'approved' as const;
    return 'user-approval' as const;
  };
}
