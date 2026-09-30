/** Webhook signature verification for Meta's X-Hub-Signature-256 header.
 *
 * Meta signs the raw request body as `sha256=` + hex(HMAC-SHA256(body,
 * app_secret)). We verify against the raw bytes the route read (not a
 * re-serialized body) and compare in constant time so a wrong signature does
 * not leak how close it was.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

export class WhatsAppSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppSignatureError';
  }
}

/** Strip the `sha256=` prefix; throws when the header is missing or malformed. */
function parseSignatureHeader(header: string | null | undefined): Buffer {
  if (!header || typeof header !== 'string' || !header.startsWith(PREFIX)) {
    throw new WhatsAppSignatureError('Missing or malformed X-Hub-Signature-256 header.');
  }
  const hex = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new WhatsAppSignatureError('Signature is not 64 hex characters.');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Verify a webhook payload. Returns true when the signature matches, false
 * when the app secret is unset (nothing to check against is not a pass) or
 * the signature is wrong. Throws WhatsAppSignatureError on a malformed
 * header — a caller that cannot even parse the claim should treat the event
 * as a client error, not a signature mismatch.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string | null | undefined,
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!appSecret) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', appSecret).update(body).digest();
  if (expected.length !== parsed.length) return false;
  return timingSafeEqual(expected, parsed);
}

/** Sign a body the way Meta would — used by tests to build valid fixtures. */
export function signForTest(rawBody: string | Buffer, appSecret: string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return PREFIX + createHmac('sha256', appSecret).update(body).digest('hex');
}
