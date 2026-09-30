/** Personal identifiers in memory: detect, redact, minimise.
 *
 * The ticket's rule, as JEV judged it (surface-review, 2026-09-30): an
 * automatically captured candidate that carries identifiers is NEVER
 * auto-saved — it is surfaced for the person to review, and the audit trail
 * carries only the kinds found, never the values. What the person types into
 * the memory screen stays verbatim (their own words), but the inspect listing
 * flags it so they can review and delete it.
 *
 * Three kinds, deliberately conservative: an email address, a phone-shaped
 * run of digits (7+ digits, so years and small amounts are not phones), and
 * an id-number shape — a long digit run, or a labelled identifier such as a
 * passport or national id number. False negatives are possible; that is why
 * this is one layer, not the whole policy.
 */

export type PiiKind = 'email' | 'phone' | 'id-number';

export type PiiHit = {
  kind: PiiKind;
  /** Where the value starts, so a caller can show context without echoing it. */
  index: number;
};

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
// A phone-shaped run: optional leading +, then digits with separators. The
// digit count is checked separately so "7500" and "2026" are never phones.
const PHONE_CANDIDATE = /\+?[\d][\d\s().-]{5,}[\d]/g;
const LONG_DIGITS = /\b\d{12,19}\b/g;
// A labelled identifier ("passport no AB1234567"): only the value part is
// claimed, and the label means this wins over the phone pattern below —
// "AB1234567" after "passport" is an id number, not a phone number.
const LABELLED_ID =
  /(passport|national id|emirates id|aadhaar|ssn|social security|id card|identity card)\b[\s\S]{0,20}?(?:no|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/gi;

const digitCount = (text: string) => (text.match(/\d/g) ?? []).length;

/** Whether a phone-candidate span is shaped like a phone number rather than
 * a bare digit run: a leading +, parens/dots/dashes, or enough spaced digits.
 * Bare runs of 7–11 digits still count ("call 5551234"); bare runs of 12+
 * are id-number shaped and left for LONG_DIGITS. This keeps "in 2026 2027"
 * (two years) from becoming a phone number. */
function isPhoneShaped(span: string): boolean {
  const digits = digitCount(span);
  if (digits < 7) return false;
  if (span.trimStart().startsWith('+')) return true;
  if (/[().-]/.test(span)) return true;
  if (/\s/.test(span)) return digits >= 10;
  return digits <= 11;
}

function spans(text: string, pattern: RegExp): { index: number; end: number }[] {
  const out: { index: number; end: number }[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push({ index: match.index, end: match.index + match[0].length });
    // Guard against zero-length matches looping forever.
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return out;
}

/** Spans of just the identifier value in labelled matches ("passport no
 * AB1234567" claims "AB1234567", not the word "passport"). */
function labelledSpans(text: string): { index: number; end: number }[] {
  const out: { index: number; end: number }[] = [];
  LABELLED_ID.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LABELLED_ID.exec(text)) !== null) {
    const value = match[2] ?? '';
    if (value) {
      // The value closes the match, so its last occurrence is the value.
      const index = match.index + match[0].lastIndexOf(value);
      out.push({ index, end: index + value.length });
    }
    if (match[0].length === 0) LABELLED_ID.lastIndex += 1;
  }
  return out;
}

const overlaps = (a: { index: number; end: number }, b: { index: number; end: number }) =>
  a.index < b.end && b.index < a.end;

/** Every identifier span in the text, strongest evidence first: a label beats
 * a bare digit run, so "passport AB1234567" is an id number, never a phone. */
function findHits(text: string): { kind: PiiKind; index: number; end: number }[] {
  const hits: { kind: PiiKind; index: number; end: number }[] = [];
  const claim = (kind: PiiKind, index: number, end: number) => {
    if (!hits.some((hit) => overlaps(hit, { index, end }))) hits.push({ kind, index, end });
  };
  for (const span of spans(text, EMAIL)) claim('email', span.index, span.end);
  for (const span of labelledSpans(text)) claim('id-number', span.index, span.end);
  for (const span of spans(text, PHONE_CANDIDATE))
    if (isPhoneShaped(text.slice(span.index, span.end))) claim('phone', span.index, span.end);
  for (const span of spans(text, LONG_DIGITS)) claim('id-number', span.index, span.end);
  return hits.sort((a, b) => a.index - b.index);
}

/** The identifier kinds found in the text, each at most once, in first-seen
 * order. Never returns the values themselves. */
export function detectPii(text: string): PiiHit[] {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];
  const kinds: PiiKind[] = [];
  const firstIndex = new Map<PiiKind, number>();
  for (const hit of findHits(source)) {
    if (!kinds.includes(hit.kind)) {
      kinds.push(hit.kind);
      firstIndex.set(hit.kind, hit.index);
    }
  }
  return kinds.map((kind) => ({ kind, index: firstIndex.get(kind) ?? 0 }));
}

/** True when the text carries any personal identifier. */
export function containsPii(text: string): boolean {
  return detectPii(text).length > 0;
}

export type PiiFinding = {
  id: string;
  title: string;
  kinds: PiiKind[];
};

/** The inspect listing: which memories carry identifiers, and which kinds —
 * never the values, and never the content. The person opens the memory
 * itself (their own data) to review it, or deletes it. */
export function inspectPii(
  memories: readonly { id: string; title: string; content: string }[],
): PiiFinding[] {
  const out: PiiFinding[] = [];
  for (const memory of memories) {
    const kinds = detectPii(`${memory.title}\n${memory.content}`).map((hit) => hit.kind);
    if (kinds.length > 0) out.push({ id: memory.id, title: memory.title, kinds });
  }
  return out;
}

const REDACTED: Record<PiiKind, string> = {
  email: '[email redacted]',
  phone: '[phone redacted]',
  'id-number': '[id redacted]',
};

/** Replace every detected identifier with its placeholder. Used where a copy
 * of the text must exist but the identifiers must not travel with it — the
 * triage audit trail, and anything rendered where the values add nothing.
 * The person's own memory rows keep their words; redaction is for the
 * secondary copies, which is what minimisation means here. */
export function redactPii(text: string): string {
  const source = typeof text === 'string' ? text : '';
  if (!source) return source;
  let out = '';
  let at = 0;
  for (const hit of findHits(source)) {
    out += source.slice(at, hit.index) + REDACTED[hit.kind];
    at = hit.end;
  }
  return out + source.slice(at);
}
