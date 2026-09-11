/** Running one approved command, on behalf of the app.
 *
 * The app has already decided that this command may run: it checked who is
 * signed in, looked up the host the owner saved, decrypted the credential for
 * this one call and, unless the command matched the owner's own auto-approve
 * list, asked them. The workbench's job is to execute it and stream what
 * happens, not to second-guess any of that.
 *
 * Output is streamed rather than returned whole so the assistant's transcript
 * fills in during a long command instead of after it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HostKeyMismatch, sshExec, type SshHost } from './ssh.ts';

/** A request body larger than this is not a command, it is a mistake. */
const MAX_BODY_BYTES = 64_000;
/** Beyond this the caller waits too long to be told anything went wrong. */
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

export class RunRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RunRequestError';
    this.status = status;
  }
}

export type RunRequest = {
  tool: 'ssh_exec';
  host: SshHost;
  command: string;
  timeoutMs: number;
};

/**
 * Validate a run request.
 *
 * Strict about the host because a malformed one is the shape a redirected
 * connection would take: every field is required and typed, and nothing is
 * defaulted except the timeout.
 */
export function parseRunRequest(raw: unknown): RunRequest {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.tool !== 'ssh_exec') throw new RunRequestError('Unknown tool.');

  const command = value.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 8_000)
    throw new RunRequestError('Send a command to run.');

  const host = (value.host ?? {}) as Record<string, unknown>;
  const text = (field: string) => {
    const found = host[field];
    if (typeof found !== 'string' || !found)
      throw new RunRequestError(`The host is missing ${field}.`);
    return found;
  };
  const port = Number(host.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RunRequestError('The host is missing a valid port.');

  const credential = (host.credential ?? {}) as Record<string, unknown>;
  let parsedCredential: SshHost['credential'];
  if (credential.type === 'key' && typeof credential.privateKey === 'string')
    parsedCredential = {
      type: 'key',
      privateKey: credential.privateKey,
      passphrase: typeof credential.passphrase === 'string' ? credential.passphrase : undefined,
    };
  else if (credential.type === 'password' && typeof credential.password === 'string')
    parsedCredential = { type: 'password', password: credential.password };
  else throw new RunRequestError('The host is missing a usable credential.');

  const fingerprint = host.fingerprint;
  if (fingerprint !== undefined && fingerprint !== null && typeof fingerprint !== 'string')
    throw new RunRequestError('The host fingerprint must be a string.');

  const timeout = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)
    throw new RunRequestError(`Set a timeout between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);

  return {
    tool: 'ssh_exec',
    command,
    timeoutMs: timeout,
    host: {
      id: text('id'),
      host: text('host'),
      port,
      username: text('username'),
      credential: parsedCredential,
      fingerprint: typeof fingerprint === 'string' && fingerprint ? fingerprint : undefined,
    },
  };
}

/** Read a bounded JSON body. An unbounded read here is a memory exhaustion. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RunRequestError('The request is too large.', 413);
    parts.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new RunRequestError('Expected a JSON request body.');
  }
}

export type RunFrame =
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | {
      type: 'exit';
      exitCode: number | null;
      truncated: boolean;
      fingerprint: string;
    }
  | {
      type: 'error';
      error: string;
      kind?: 'host-key-mismatch';
      expected?: string;
      actual?: string;
    };

/**
 * Execute a run and stream its frames.
 *
 * Separated from the HTTP plumbing so the lifecycle can be tested against a
 * real SSH server without a socket in the way.
 */
export async function* runFrames(
  request: RunRequest,
  options: { signal?: AbortSignal; exec?: typeof sshExec } = {},
): AsyncGenerator<RunFrame> {
  const exec = options.exec ?? sshExec;
  // Output arrives on a callback while the command runs, but this is a
  // generator: the queue is what bridges the two without dropping a chunk that
  // arrives between yields.
  const queue: RunFrame[] = [];
  let wake: (() => void) | null = null;
  const push = (frame: RunFrame) => {
    queue.push(frame);
    wake?.();
    wake = null;
  };

  let finished: RunFrame | null = null;
  const done = exec(request.host, request.command, {
    timeoutMs: request.timeoutMs,
    signal: options.signal,
    onOutput: (stream, data) => push({ type: 'output', stream, data }),
  }).then(
    (result) => {
      finished = {
        type: 'exit',
        exitCode: result.exitCode,
        truncated: result.truncated,
        fingerprint: result.fingerprint,
      };
    },
    (error: unknown) => {
      finished =
        error instanceof HostKeyMismatch
          ? {
              type: 'error',
              error: error.message,
              kind: 'host-key-mismatch',
              expected: error.expected,
              actual: error.actual,
            }
          : {
              type: 'error',
              error: error instanceof Error ? error.message : 'The command failed.',
            };
    },
  );

  let settled = false;
  void done.then(() => {
    settled = true;
    wake?.();
    wake = null;
  });

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  while (queue.length) yield queue.shift()!;
  await done;
  if (finished) yield finished;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  // Nothing should buffer a stream whose whole purpose is to arrive early.
  'X-Accel-Buffering': 'no',
};

/** Stream a run's frames to the app as server-sent events. */
export async function writeRunStream(
  response: ServerResponse,
  request: RunRequest,
  options: { signal?: AbortSignal; exec?: typeof sshExec } = {},
): Promise<void> {
  response.writeHead(200, SSE_HEADERS);
  try {
    for await (const frame of runFrames(request, options)) {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  } catch (error) {
    // The stream is already open with a 200, so a late failure has to be told
    // in-band rather than as a status code.
    const message = error instanceof Error ? error.message : 'The command failed.';
    response.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
  } finally {
    response.end();
  }
}
