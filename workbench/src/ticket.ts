/** Single-use tickets for browser connections.
 *
 * The workbench has no session store and no idea who is signed in. The app does
 * the authentication and then signs a short-lived ticket; the workbench only
 * checks that the signature is its own and that the ticket has not been used or
 * expired. That keeps the authority in one place rather than duplicating
 * session handling into a second service where it could drift.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Long enough to click a link, short enough that a leaked URL is worthless. */
export const TICKET_TTL_MS = 30_000;

export type TicketPayload = {
  /** Which capability the ticket authorises. */
  scope: 'terminal' | 'ssh';
  /** Milliseconds since the epoch, after which the ticket is dead. */
  expiresAt: number;
  /** Saved SSH host id, for scope 'ssh'. */
  hostId?: string;
  /** Random, so two tickets are never byte-identical and replay is detectable. */
  nonce: string;
};

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Mint a ticket. Called by the app, never by the workbench. */
export function issueTicket(
  payload: Omit<TicketPayload, 'expiresAt' | 'nonce'>,
  secret: string,
  now: number = Date.now(),
): string {
  const body = encode({
    ...payload,
    expiresAt: now + TICKET_TTL_MS,
    nonce: randomBytes(12).toString('base64url'),
  });
  return `${body}.${sign(body, secret)}`;
}

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketError';
  }
}

/**
 * Verify a ticket's signature and freshness.
 *
 * Single use is enforced by the caller through `seen`, because the set has to
 * outlive one verification and belongs to the server, not to this function.
 */
export function verifyTicket(
  ticket: string,
  secret: string,
  options: { now?: number; seen?: Set<string> } = {},
): TicketPayload {
  const now = options.now ?? Date.now();
  const separator = ticket.lastIndexOf('.');
  if (separator <= 0) throw new TicketError('Malformed ticket.');
  const body = ticket.slice(0, separator);
  const provided = ticket.slice(separator + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare in constant time, and only when the lengths already match:
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new TicketError('Invalid ticket.');

  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new TicketError('Malformed ticket.');
  }
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= now)
    throw new TicketError('This ticket has expired. Reopen the terminal.');
  if (payload.scope !== 'terminal' && payload.scope !== 'ssh')
    throw new TicketError('Unknown ticket scope.');

  if (options.seen) {
    if (options.seen.has(payload.nonce)) throw new TicketError('This ticket was already used.');
    options.seen.add(payload.nonce);
  }
  return payload;
}

/** Drop nonces that can no longer be replayed, so the set cannot grow without
 * bound over the life of the process. */
export function pruneSeen(seen: Map<string, number>, now: number = Date.now()): void {
  for (const [nonce, expiresAt] of seen) if (expiresAt <= now) seen.delete(nonce);
}
