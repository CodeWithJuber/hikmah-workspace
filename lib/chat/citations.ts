// Inline citation pills (P1-9): where the answer text carries numbered markers
// like [1], thread them to the message's deduped source list as superscript
// pill links. Sources arrive as AI SDK `source-url` / `source-document`
// parts; the markers are the Perplexity-style convention some providers emit
// alongside them.
//
// Threading is done by a settled-only DOM effect (see
// components/chat/citation-pills.tsx), not through markdown: streamdown's
// linkSafety rewrites every <a> — markdown or raw HTML — into a <button>,
// so real anchors cannot come out of the markdown pipeline, and splitting
// the markdown around pills would break paragraph flow. Everything
// decision-shaped lives here, pure and unit-tested; the component only
// walks text nodes and builds the <a> elements.

export type CitedSource = {
  type: 'source-url' | 'source-document';
  url?: string;
  title?: string;
};

/** One entry per distinct source, first occurrence wins, original order kept. */
export function dedupeSources<T extends CitedSource>(parts: T[]): T[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.url ?? part.title ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Anchor id for a source-list entry within a message. Message ids are
 *  caller-supplied, so anything outside [a-zA-Z0-9-_] is neutralised. */
export function sourceAnchorId(messageId: string, index: number): string {
  const safe = String(messageId).replace(/[^a-zA-Z0-9-_]/g, '-');
  return `cite-${safe}-${index}`;
}

/** A marker resolves only to a source that can actually be shown or followed.
 *  A pill for a source with no URL/title would point nowhere — the plan
 *  requires those markers to stay plain text. */
function resolvableSource(sources: CitedSource[], n: number): CitedSource | null {
  if (n < 1 || n > sources.length) return null;
  const source = sources[n - 1];
  return source.url || source.title ? source : null;
}

export type CitationMarker = {
  /** Offset of the '[' in the scanned string. */
  start: number;
  /** Offset just past the ']'. */
  end: number;
  /** Zero-based index into the deduped sources. */
  index: number;
};

const MARKER_PATTERN = /\[(\d+)\](?![\(\[])/g;

/** Resolvable [n] markers in a plain-text string, in order. The DOM effect
 *  calls this per text node, having already excluded code, tables and links
 *  by ancestor — so the guards here are only range, resolvability, and not
 *  being part of a markdown link/image. */
export function findCitationMarkers(text: string, sources: CitedSource[]): CitationMarker[] {
  if (!text || sources.length === 0) return [];
  const markers: CitationMarker[] = [];
  MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_PATTERN.exec(text)) !== null) {
    const n = Number(match[1]);
    if (!resolvableSource(sources, n)) continue;
    markers.push({ start: match.index, end: match.index + match[0].length, index: n - 1 });
  }
  return markers;
}

/** Human label for a pill's title/aria: the source title, else its URL. */
export function sourceLabel(source: CitedSource): string {
  return source.title ?? source.url ?? 'Source';
}

/** Accessible name for a pill link: the number alone means nothing to a
 *  screen-reader user tabbing through the answer. */
export function pillAriaLabel(n: number, source: CitedSource): string {
  return `Source ${n}: ${sourceLabel(source)}`;
}
