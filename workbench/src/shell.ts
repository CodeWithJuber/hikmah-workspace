/** Running commands inside the workbench itself.
 *
 * Unlike `ssh.ts`, which reaches a machine the owner saved, this runs here: in
 * the sidecar container, on the workspace volume, as an unprivileged user with
 * every capability dropped and no route to the app's database or its secrets.
 * That container boundary is the sandbox. It is not a jail — a command here has
 * network access and can read anything the shell user can — so the approval gate
 * on the app side is what decides whether a command runs at all, and the card
 * says plainly where it will run.
 *
 * Sessions are per conversation so `cd` carries between calls, which is how
 * people actually use a shell and how every coding agent expects one to behave.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Inline output cap, matching the SSH path so the model sees one rule. */
export const MAX_INLINE_OUTPUT = 30_000;
/** A command that prints nothing for this long is probably waiting for input. */
export const QUIET_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Interpreters a sandbox_run may name. Anything else is a command, not a language. */
export const LANGUAGES = { python: 'python3', node: 'node' } as const;

export type Language = keyof typeof LANGUAGES;

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  /** The directory the next command in this session will start in. */
  cwd: string;
  /** Set when the command was still running when its time ran out. */
  timedOut?: boolean;
  /** Where the full output was written, when it outgrew the inline cap. */
  logPath?: string;
};

/** One conversation's working directory, remembered between commands. */
export type ShellSession = { id: string; cwd: string };

export type ShellOptions = {
  /** Root of the workspace volume. A session can never start outside it. */
  workspace: string;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected by the tests. */
  spawnProcess?: typeof spawn;
};

export class ShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellError';
  }
}

/**
 * Keep a path inside the workspace.
 *
 * A session's cwd comes back from the shell itself, so a command that cds
 * outside the volume would otherwise move the session there permanently. This
 * is not a security boundary — the container already is one — it keeps a stray
 * `cd /` from making the session useless.
 */
export function containPath(workspace: string, candidate: string): string {
  const root = resolve(workspace);
  const target = resolve(candidate);
  return target === root || target.startsWith(root + '/') ? target : root;
}

export function createSessions(workspace: string) {
  const sessions = new Map<string, ShellSession>();
  return {
    /** The session for a conversation, created on first use. */
    for(id: string): ShellSession {
      const existing = sessions.get(id);
      if (existing) return existing;
      const session = { id, cwd: resolve(workspace) };
      sessions.set(id, session);
      return session;
    },
    /** Forget where a session was, without ending anything: there is no
     * long-lived process to kill, only a remembered directory. */
    reset(id: string): void {
      sessions.delete(id);
    },
    get size() {
      return sessions.size;
    },
  };
}

/** A marker the shell prints after the command, so its final cwd comes back
 * with the output rather than needing a second round trip. */
const CWD_MARKER = '__hikmah_cwd__';

/**
 * Run one command in a session and report where it left the shell.
 *
 * `bash -lc` rather than a bare exec: the model writes shell, with pipes and
 * redirects and `&&`, and pretending otherwise would mean re-implementing a
 * shell badly. The approval gate is what makes that safe, not a parser.
 */
export async function runCommand(
  session: ShellSession,
  command: string,
  options: ShellOptions,
): Promise<ShellResult> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const script = `${command}\n__status=$?\nprintf '\\n${CWD_MARKER}%s\\n' "$PWD"\nexit $__status`;

  const child = spawnProcess('bash', ['-lc', script], {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'dumb' },
  }) as ChildProcessWithoutNullStreams;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const full: string[] = [];
  let size = 0;
  let truncated = false;
  let timedOut = false;

  const record = (stream: 'stdout' | 'stderr', text: string) => {
    options.onOutput?.(stream, text);
    full.push(text);
    if (size >= MAX_INLINE_OUTPUT) {
      truncated = true;
      return;
    }
    const kept = text.slice(0, MAX_INLINE_OUTPUT - size);
    if (kept.length < text.length) truncated = true;
    size += kept.length;
    (stream === 'stdout' ? stdout : stderr).push(kept);
  };

  const exitCode = await new Promise<number | null>((settle) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(quiet);
      options.signal?.removeEventListener('abort', onAbort);
      settle(code);
    };

    // SIGKILL after SIGTERM: a shell that ignores the polite signal must not be
    // able to hold the session open past its limit.
    const stop = () => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    };

    const deadline = setTimeout(stop, timeoutMs);
    (deadline as unknown as { unref?: () => void }).unref?.();

    // A command silent this long is usually waiting for input nobody will give
    // it. Reported rather than killed, because a long build is also silent.
    let quiet = setTimeout(() => {
      options.onOutput?.('stderr', `\n[no output for ${QUIET_TIMEOUT_MS / 1000}s]\n`);
    }, QUIET_TIMEOUT_MS);
    (quiet as unknown as { unref?: () => void }).unref?.();
    const bumpQuiet = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        options.onOutput?.('stderr', `\n[no output for ${QUIET_TIMEOUT_MS / 1000}s]\n`);
      }, QUIET_TIMEOUT_MS);
      (quiet as unknown as { unref?: () => void }).unref?.();
    };

    const onAbort = () => stop();
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      bumpQuiet();
      record('stdout', chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bumpQuiet();
      record('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error: Error) => {
      record('stderr', error.message);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
    // Nothing is typed into these commands; leaving stdin open would make a
    // program that reads it hang until the deadline instead of failing.
    child.stdin?.end();
  });

  // The marker is on stdout, so it is stripped from what the caller sees.
  const joined = stdout.join('');
  const marker = joined.lastIndexOf(CWD_MARKER);
  let cwd = session.cwd;
  if (marker !== -1) {
    const line = joined.slice(marker + CWD_MARKER.length).split('\n')[0];
    cwd = containPath(options.workspace, line.trim() || session.cwd);
  }
  session.cwd = cwd;

  // Only the newline printf added before the marker is removed. The command's
  // own trailing newline is its output, and swallowing it would quietly corrupt
  // anything read with `cat`.
  const beforeMarker = marker === -1 ? joined : joined.slice(0, marker);
  const result: ShellResult = {
    stdout: beforeMarker.endsWith('\n') ? beforeMarker.slice(0, -1) : beforeMarker,
    stderr: stderr.join(''),
    exitCode,
    truncated,
    cwd,
    ...(timedOut ? { timedOut: true } : {}),
  };

  // Output that outgrew the cap is kept where the assistant can go and read it
  // rather than simply lost.
  if (truncated) {
    const directory = join(resolve(options.workspace), '.runs');
    const path = join(directory, `${Date.now()}-${session.id}.log`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, full.join(''), 'utf8');
      result.logPath = path;
    } catch {
      /* the volume may be read-only or full; the inline output still stands */
    }
  }

  return result;
}

/**
 * Run a short program in one of the interpreters the image carries.
 *
 * The code goes in on a file rather than on the command line: a heredoc or a
 * `-c` argument would make quoting the model's problem, and it is not one it
 * should have to solve to print a string.
 */
export async function runSnippet(
  session: ShellSession,
  language: Language,
  code: string,
  options: ShellOptions,
): Promise<ShellResult> {
  const interpreter = LANGUAGES[language];
  if (!interpreter)
    throw new ShellError(
      `Unknown language "${language}". Use ${Object.keys(LANGUAGES).join(' or ')}.`,
    );

  const directory = join(resolve(options.workspace), '.runs');
  const path = join(
    directory,
    `snippet-${Date.now()}-${session.id}.${language === 'python' ? 'py' : 'mjs'}`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path, code, 'utf8');
  return runCommand(session, `${interpreter} ${JSON.stringify(path)}`, options);
}
