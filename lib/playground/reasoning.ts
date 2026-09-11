/** Provider-returned explanation blocks. Opaque continuation data is retained,
 * never rendered or decoded. No synthetic private reasoning is produced here. */
export type ReasoningDetail = {
  type: string;
  index?: number;
  id?: string;
  format?: string;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string;
};
export function normalizeReasoningDetails(value: unknown): ReasoningDetail[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128)
    throw Error('Invalid provider explanation blocks.');
  let size = 0;
  return value.map((v) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      typeof v.type !== 'string' ||
      v.type.length > 80
    )
      throw Error('Invalid provider explanation block.');
    const out: ReasoningDetail = { type: v.type };
    if (v.index !== undefined) {
      if (!Number.isInteger(v.index) || v.index < 0 || v.index > 127)
        throw Error('Invalid explanation index.');
      out.index = v.index;
    }
    for (const k of ['id', 'format', 'text', 'summary', 'data', 'signature'] as const)
      if (v[k] !== undefined) {
        if (typeof v[k] !== 'string' || v[k].length > (['id', 'format'].includes(k) ? 256 : 200000))
          throw Error('Invalid explanation content.');
        size += v[k].length;
        out[k] = v[k];
      }
    if (size > 200000) throw Error('Explanation blocks are too large.');
    return out;
  });
}
export function mergeReasoningDetails(
  current: ReasoningDetail[],
  delta: ReasoningDetail[],
): ReasoningDetail[] {
  const out = current.map((v) => ({ ...v }));
  delta.forEach((part, position) => {
    const index = part.index ?? position;
    let at = out.findIndex((v) => (v.index ?? out.indexOf(v)) === index);
    if (at < 0) {
      out.push({ ...part, index });
      return;
    }
    const previous = out[at];
    if (previous.type !== part.type || (previous.id && part.id && previous.id !== part.id))
      throw Error('Provider changed an explanation block identity.');
    const joined = { ...previous, ...part, index };
    for (const k of ['text', 'summary', 'data', 'signature'] as const)
      if (part[k] !== undefined) joined[k] = (previous[k] ?? '') + part[k];
    out[at] = joined;
  });
  return normalizeReasoningDetails(out)!;
}
export function publicExplanation(details: ReasoningDetail[] | undefined): string {
  return (details ?? [])
    .filter((d) => d.type !== 'reasoning.encrypted')
    .map((d) => d.summary ?? d.text ?? '')
    .filter(Boolean)
    .join('\n');
}

export function readableExplanation(
  reasoning: string | undefined,
  details: ReasoningDetail[] | undefined,
): string {
  const a = reasoning ?? '',
    b = publicExplanation(details);
  if (!a || b.includes(a)) return b;
  if (!b || a.includes(b)) return a;
  return a + '\n' + b;
}
