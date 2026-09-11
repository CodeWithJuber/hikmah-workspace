/** Talking to the workbench from the app.
 *
 * The credential is decrypted here, for one call, and travels over the private
 * compose network to a service that holds no secrets of its own. The alternative
 * — giving the workbench the vault key — would mean a shell could read every
 * saved secret, so the key never leaves this side.
 */
import type { RunFrame } from './frames.ts';

export class WorkbenchUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchUnavailable';
  }
}

export type WorkbenchConfig = { url: string; token: string };

/** Read the sidecar's address and token, or say plainly that it is not set up. */
export function workbenchConfig(env: NodeJS.ProcessEnv = process.env): WorkbenchConfig {
  const url = env.HIKMAH_WORKBENCH_URL ?? '';
  const token = env.HIKMAH_WORKBENCH_TOKEN ?? '';
  if (!url || token.length < 32)
    throw new WorkbenchUnavailable(
      'Running commands needs the workbench service. Set HIKMAH_WORKBENCH_URL and HIKMAH_WORKBENCH_TOKEN, and start the workbench container.',
    );
  return { url: url.replace(/\/+$/, ''), token };
}

export type SshCredential =
  { type: 'key'; privateKey: string; passphrase?: string } | { type: 'password'; password: string };

export type SshExecRequest = {
  host: {
    id: string;
    host: string;
    port: number;
    username: string;
    credential: SshCredential;
    fingerprint?: string;
  };
  command: string;
  timeoutMs?: number;
};

/**
 * Run one command and yield the workbench's frames as they arrive.
 *
 * The response is consumed as a stream rather than awaited whole so the caller
 * can surface output during a long command.
 */
/**
 * Run one command in the workbench container and yield its frames.
 *
 * The same endpoint and the same framing as sshExecStream: the workbench
 * distinguishes them by the `tool` field, so there is one transport to get
 * right rather than two.
 */
export async function* workbenchStream(
  request: Record<string, unknown>,
  options: { signal?: AbortSignal; config?: WorkbenchConfig; fetch?: typeof globalThis.fetch } = {},
): AsyncGenerator<RunFrame> {
  yield* postRun(request, options);
}

export async function* sshExecStream(
  request: SshExecRequest,
  options: { signal?: AbortSignal; config?: WorkbenchConfig; fetch?: typeof globalThis.fetch } = {},
): AsyncGenerator<RunFrame> {
  yield* postRun({ tool: 'ssh_exec', ...request }, options);
}

/** POST one run to the workbench and yield the frames it streams back. */
async function* postRun(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; config?: WorkbenchConfig; fetch?: typeof globalThis.fetch } = {},
): AsyncGenerator<RunFrame> {
  const config = options.config ?? workbenchConfig();
  const call = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await call(`${config.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new WorkbenchUnavailable('The workbench service could not be reached.');
  }

  if (!response.ok || !response.body) {
    const detail = await response
      .text()
      .then((text) => {
        try {
          return String(JSON.parse(text).error ?? '');
        } catch {
          return '';
        }
      })
      .catch(() => '');
    throw new WorkbenchUnavailable(
      detail || `The workbench refused the command (${response.status}).`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; a partial one stays in the buffer
      // until the rest of it arrives.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(block);
        if (frame) yield frame;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(block: string): RunFrame | null {
  const line = block.split('\n').find((entry) => entry.startsWith('data: '));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(6));
    return parsed && typeof parsed.type === 'string' ? (parsed as RunFrame) : null;
  } catch {
    return null;
  }
}
