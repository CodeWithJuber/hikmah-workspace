/** Interactive shells for the terminal panel.
 *
 * A pty rather than a plain child process: without one, programs that check
 * isatty (an editor, a pager, anything with a progress bar) behave as though
 * their output is being piped to a file, and the panel stops being a terminal
 * in any useful sense.
 */
import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { shellEnvironment } from './env.ts';
import type { Slot } from './slots.ts';

/** Output is forwarded to a socket, so a program printing without pause would
 * otherwise fill memory faster than the network drains it. */
const MAX_PENDING_BYTES = 1_000_000;

export { shellEnvironment };

export type TerminalSession = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type TerminalOptions = {
  cwd: string;
  onData: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
  cols?: number;
  rows?: number;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  /** Whose shell this is: the uid to drop to and the directory to stay in.
   * Absent only in the tests, which have no pool of users to drop to. */
  slot?: Slot;
  /** Injected by the tests so they do not need a real pty. */
  spawn?: typeof pty.spawn;
};

/** Where the image installs the login wrapper. See workbench/bin/hikmah-shell. */
export const SHELL_WRAPPER = '/usr/local/bin/hikmah-shell';

export function createTerminal(options: TerminalOptions): TerminalSession {
  const spawn = options.spawn ?? pty.spawn;
  const slot = options.slot;
  const environment = shellEnvironment(options.env ?? process.env);

  // The same rule as the assistant's commands (see shell.ts): the directory is
  // an argument to the wrapper, which cds after the uid has dropped, because
  // node-pty also chdir's before it setuid's and the supervisor cannot enter a
  // 0700 slot directory itself.
  const wrapper = process.env.HIKMAH_SHELL_WRAPPER || SHELL_WRAPPER;
  const command = slot ? wrapper : (options.shell ?? process.env.SHELL ?? '/bin/bash');
  const args = slot ? [slot.home] : ['-l'];

  const child = spawn(command, args, {
    name: 'xterm-256color',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: {
      ...environment,
      ...(slot ? { HOME: slot.home, USER: slot.name, LOGNAME: slot.name } : {}),
    } as Record<string, string>,
    ...(slot ? { uid: slot.uid, gid: slot.gid } : {}),
  });

  let pending = 0;
  let exited = false;

  child.onData((data: string) => {
    // Backpressure is not something a pty offers, so a runaway program is cut
    // off rather than allowed to exhaust the process.
    pending += Buffer.byteLength(data);
    if (pending > MAX_PENDING_BYTES) {
      pending = 0;
      options.onData('\r\n[output stopped: the program printed too fast]\r\n');
      kill();
      return;
    }
    pending = 0;
    options.onData(data);
  });

  child.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    exited = true;
    options.onExit(exitCode, signal);
  });

  function kill(): void {
    if (exited) return;
    exited = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  return {
    pid: child.pid,
    write(data: string) {
      if (!exited) child.write(data);
    },
    resize(cols: number, rows: number) {
      if (exited) return;
      // A zero or absurd size makes the pty ioctl fail and can wedge the shell.
      const safeCols = Math.min(Math.max(Math.trunc(cols) || 80, 1), 500);
      const safeRows = Math.min(Math.max(Math.trunc(rows) || 24, 1), 300);
      try {
        child.resize(safeCols, safeRows);
      } catch {
        /* the shell exited between the check and the call */
      }
    },
    kill,
  };
}
