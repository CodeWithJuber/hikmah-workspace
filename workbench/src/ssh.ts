/** SSH to hosts the owner has saved.
 *
 * The model may name a saved host and a command. It may never supply a
 * hostname, a username, a key path or a port: those come from the owner's own
 * record, so a prompt-injected instruction cannot redirect a connection to an
 * attacker's machine.
 */
import { Client, type ConnectConfig } from 'ssh2';

export type SshHost = {
  id: string;
  host: string;
  port: number;
  username: string;
  /** Private key or password, decrypted by the app for this one connection. */
  credential:
    | { type: 'key'; privateKey: string; passphrase?: string }
    | { type: 'password'; password: string };
  /** SHA-256 of the host key, pinned on first connection. */
  fingerprint?: string;
};

export class HostKeyMismatch extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      'The host key has changed since this host was added. This is what a machine-in-the-middle looks like, so the connection was refused. If you rebuilt the server, remove the host and add it again.',
    );
    this.name = 'HostKeyMismatch';
    this.expected = expected;
    this.actual = actual;
  }
}

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  /** The fingerprint observed, so a first connection can pin it. */
  fingerprint: string;
};

/** Inline output cap. Beyond this the caller is told to look at the log. */
export const MAX_INLINE_OUTPUT = 30_000;

function connectConfig(host: SshHost, verifier: (hash: Buffer) => boolean): ConnectConfig {
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    ...(host.credential.type === 'key'
      ? { privateKey: host.credential.privateKey, passphrase: host.credential.passphrase }
      : { password: host.credential.password }),
    // ssh2 accepts any host key when hostVerifier is absent, which would make
    // the pin meaningless, so it is never omitted.
    hostHash: 'sha256',
    hostVerifier: verifier as unknown as ConnectConfig['hostVerifier'],
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };
}

/**
 * Run one command on a saved host.
 *
 * `onOutput` receives output as it arrives so the assistant's transcript fills
 * in live rather than waiting for the command to finish.
 */
export function sshExec(
  host: SshHost,
  command: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
    createClient?: () => Client;
  } = {},
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const client = options.createClient ? options.createClient() : new Client();
    let observed = '';
    let settled = false;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let size = 0;
    let truncated = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        client.end();
      } catch {
        /* already closed */
      }
      fn();
    };

    const onAbort = () => finish(() => reject(new Error('The command was stopped.')));
    const deadline = setTimeout(
      () => finish(() => reject(new Error('The command reached its time limit and was stopped.'))),
      options.timeoutMs ?? 120_000,
    );
    (deadline as unknown as { unref?: () => void }).unref?.();

    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const record = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onOutput?.(stream, text);
      if (size >= MAX_INLINE_OUTPUT) {
        truncated = true;
        return;
      }
      const room = MAX_INLINE_OUTPUT - size;
      const kept = text.slice(0, room);
      if (kept.length < text.length) truncated = true;
      size += kept.length;
      (stream === 'stdout' ? stdout : stderr).push(kept);
    };

    client.on('error', (error) => finish(() => reject(error)));

    client.on('ready', () => {
      client.exec(command, { pty: false }, (error, stream) => {
        if (error) return finish(() => reject(error));
        let exitCode: number | null = null;
        stream.on('data', (chunk: Buffer) => record('stdout', chunk));
        stream.stderr.on('data', (chunk: Buffer) => record('stderr', chunk));
        stream.on('exit', (code: number | null) => {
          exitCode = code;
        });
        stream.on('close', () =>
          finish(() =>
            resolve({
              stdout: stdout.join(''),
              stderr: stderr.join(''),
              exitCode,
              truncated,
              fingerprint: observed,
            }),
          ),
        );
      });
    });

    client.connect(
      connectConfig(host, (hash: Buffer) => {
        observed = Buffer.isBuffer(hash) ? hash.toString('hex') : String(hash);
        // First connection: accept and let the caller pin what was seen. After
        // that, any change refuses the connection rather than warning.
        if (!host.fingerprint) return true;
        if (host.fingerprint === observed) return true;
        finish(() => reject(new HostKeyMismatch(host.fingerprint!, observed)));
        return false;
      }),
    );
  });
}
