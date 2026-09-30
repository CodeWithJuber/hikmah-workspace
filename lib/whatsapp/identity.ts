/** Phone <-> workspace-user identity mapping.
 *
 * WhatsApp identifies people by phone number; the workspace identifies them
 * by user id. The link between the two is explicit only: the owner requests
 * a short code, reads it to the user out of band (on the phone call, in
 * person), and confirms it here. There is no silent auto-linking — an
 * inbound message from an unlinked number is recorded against the number,
 * never attributed to a user.
 */
import { createHash, randomInt } from 'node:crypto';

export class WhatsAppIdentityError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WhatsAppIdentityError';
    this.status = status;
  }
}

/** Normalize to E.164-ish digits with a leading `+`. Throws on garbage. */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new WhatsAppIdentityError(`"${raw}" is not a usable phone number.`, 400);
  }
  return '+' + digits;
}

/** Six digits, grouped for reading aloud: "482 913". */
export function mintLinkCode(): string {
  const n = randomInt(0, 1_000_000);
  const padded = String(n).padStart(6, '0');
  return padded.slice(0, 3) + ' ' + padded.slice(3);
}

/** Store only the hash of the code, like an approval token. */
export function linkCodeHash(code: string): string {
  return createHash('sha256').update(code.replace(/\s+/g, '')).digest('hex');
}

/** A code is valid when the hashes match and it has not expired. */
export function verifyLinkCode(
  code: string,
  storedHash: string | null,
  expiresAt: string | null,
  nowMs: number,
): boolean {
  if (!storedHash || !expiresAt) return false;
  if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= nowMs) return false;
  return linkCodeHash(code) === storedHash;
}

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
