/** Minting tickets for the workbench.
 *
 * The app knows who is signed in; the workbench does not. Rather than teach a
 * second service to read sessions — where the rules would drift — the app signs
 * a short-lived, single-use ticket and the workbench checks only the signature.
 *
 * The verifying half lives in `workbench/src/ticket.ts`. The two are deliberate
 * duplicates: the workbench is a separate package with its own dependencies, so
 * it cannot import from here. `tests/workbench-ticket.test.mjs` issues with this
 * code and verifies with that code, so a change to either format fails loudly.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** Long enough to open a socket, short enough that a leaked URL is worthless. */
export const TICKET_TTL_MS = 30_000;

export type TicketScope = 'terminal' | 'ssh';

export class WorkbenchError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WorkbenchError';
    this.status = status;
  }
}

/** The shared secret, which is also the ticket signing key. */
export function workbenchToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.HIKMAH_WORKBENCH_TOKEN ?? '';
  // A short token is a guessable one, and the failure would otherwise show up
  // as an unexplained 401 from the workbench.
  if (token.length < 32)
    throw new WorkbenchError(
      'The terminal is not configured on this deployment. Set HIKMAH_WORKBENCH_TOKEN and start the workbench service.',
      503,
    );
  return token;
}

export function issueTicket(
  payload: {
    scope: TicketScope;
    hostId?: string;
    /** Whose terminal this is, as the workbench's opaque name for them
     * (lib/workbench/user-key.ts). Signed, so the browser cannot choose it, and
     * required — a ticket that names no account opened a pty in the shared
     * workspace, which is the inverse of the bug on the model's path. */
    userKey?: string;
  },
  secret: string,
  now: number = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      expiresAt: now + TICKET_TTL_MS,
      nonce: randomBytes(12).toString('base64url'),
    }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/**
 * Where the browser should connect.
 *
 * Caddy proxies /ws/* to the workbench on the same hostname, so the socket
 * inherits the app's certificate and its Origin — which is the only thing the
 * workbench can use to tell our page from any other.
 */
export function terminalUrl(origin: string, ticket: string): string {
  const url = new URL('/ws/terminal', origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
