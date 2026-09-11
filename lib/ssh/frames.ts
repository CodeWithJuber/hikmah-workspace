/** The frames the workbench streams back for one command.
 *
 * Mirrors `workbench/src/runs.ts`. The two packages cannot import each other, so
 * `tests/ssh-client.test.mjs` drives this parser with frames the workbench
 * actually produced rather than with hand-written fixtures.
 */
export type RunFrame =
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; exitCode: number | null; truncated: boolean; fingerprint: string }
  | {
      type: 'error';
      error: string;
      kind?: 'host-key-mismatch';
      expected?: string;
      actual?: string;
    };

/** What a finished command amounts to, once its frames are folded together. */
export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  fingerprint?: string;
  error?: string;
  hostKeyChanged?: boolean;
};

/** Inline output cap, matching the workbench's own. */
export const MAX_INLINE_OUTPUT = 30_000;

/**
 * Fold a stream of frames into one result.
 *
 * Output is kept even when the command later fails: a timeout after ten lines
 * of useful output should show those ten lines, not an empty error.
 */
export function foldFrames(frames: Iterable<RunFrame>): CommandResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let size = 0;
  const result: CommandResult = { stdout: '', stderr: '', exitCode: null, truncated: false };

  for (const frame of frames) {
    if (frame.type === 'output') {
      const room = MAX_INLINE_OUTPUT - size;
      if (room <= 0) {
        result.truncated = true;
        continue;
      }
      const kept = frame.data.slice(0, room);
      if (kept.length < frame.data.length) result.truncated = true;
      size += kept.length;
      (frame.stream === 'stdout' ? stdout : stderr).push(kept);
    } else if (frame.type === 'exit') {
      result.exitCode = frame.exitCode;
      result.truncated = result.truncated || frame.truncated;
      result.fingerprint = frame.fingerprint;
    } else {
      result.error = frame.error;
      if (frame.kind === 'host-key-mismatch') result.hostKeyChanged = true;
    }
  }

  result.stdout = stdout.join('');
  result.stderr = stderr.join('');
  return result;
}
