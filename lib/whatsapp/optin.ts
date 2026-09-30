/** Consent-first opt-in state machine.
 *
 * A number starts with no row at all (unknown). Only an explicit owner act
 * (posting /api/whatsapp/optin, or an attested import) moves it to
 * opted_in, and the user texting a STOP keyword always wins over everything
 * else — an opt-out is never undone except by the user texting START again.
 */

export type OptInState = 'opted_in' | 'opted_out';
export type OptInVerdict = 'opt_out' | 'opt_in' | null;

const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit', 'stopall']);
const OPT_IN_KEYWORDS = new Set(['start', 'subscribe', 'unstop', 'yes']);

/**
 * Read an inbound text for a consent keyword. Only a whole trimmed message
 * counts — "stop by later" is not an opt-out. Case-insensitive.
 */
export function classifyKeyword(text: string | null | undefined): OptInVerdict {
  if (!text) return null;
  const word = text
    .trim()
    .toLowerCase()
    .replace(/^["'“”]+|["'“”.,!;]+$/g, '');
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(word)) return 'opt_in';
  return null;
}

/**
 * Fold a keyword verdict into the current state. Unknown (null) never
 * becomes a row on its own: the caller decides whether to persist.
 */
export function nextOptInState(
  current: OptInState | null,
  verdict: OptInVerdict,
): OptInState | null {
  if (verdict === 'opt_out') return 'opted_out';
  if (verdict === 'opt_in') return 'opted_in';
  return current;
}

/** Sending is allowed only with a recorded opt-in — unknown is not consent. */
export function maySendTo(state: OptInState | 'unknown' | null | undefined): boolean {
  return state === 'opted_in';
}
