/** Reads of public reference sources, shared by the HTTP tool route and the
 * server-side agent tools.
 *
 * These were inlined in `webToolRequest`, which mixed request handling with the
 * fetch itself. Pulling the two operations out lets the agent call them
 * directly, without a self-request through the app's own HTTP surface, and
 * keeps one implementation of the URL policy and the size bounds.
 */
import { publicPageUrl, readBounded } from './web-tools.ts';

/** A failure of the upstream source, as opposed to a bad request from us.
 * Carries the status the HTTP route should report so that "Wikipedia is rate
 * limiting" stays a 502 and does not become a 400 about the caller's input. */
export class UpstreamSourceError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'UpstreamSourceError';
    this.status = status;
  }
}

const USER_AGENT = 'Hikmah/1.0 (public research tools)';
/** Characters returned per read_webpage call; the model pages with `offset`. */
export const PAGE_WINDOW = 24000;
const REFERENCE_LANGUAGES = ['en', 'ar', 'hi', 'es', 'tr'] as const;
export type ReferenceLanguage = (typeof REFERENCE_LANGUAGES)[number];

async function fetchText(target: string, accept: string, signal: AbortSignal) {
  const upstream = await fetch(target, {
    headers: { Accept: accept, 'User-Agent': USER_AGENT },
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    throw new UpstreamSourceError(
      upstream.status === 429
        ? 'The public source is rate limited. Try later or use your connected service.'
        : `The public source is unavailable (HTTP ${upstream.status}). Try another URL or connected service.`,
    );
  }
  return readBounded(upstream, signal);
}

/** Search Wikipedia. Encyclopedia lookup, not general web search. */
export async function searchReference(
  query: unknown,
  language: unknown,
  signal: AbortSignal,
): Promise<{
  service: string;
  retrievedAt: string;
  results: { title: string; url: string; snippet: string }[];
}> {
  if (typeof query !== 'string' || !query.trim() || query.length > 300)
    throw Error('Enter a reference query up to 300 characters.');
  const lang: ReferenceLanguage = REFERENCE_LANGUAGES.includes(language as ReferenceLanguage)
    ? (language as ReferenceLanguage)
    : 'en';
  const source = 'https://' + lang + '.wikipedia.org';
  const url = new URL(source + '/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
  }).toString();
  const json = JSON.parse(await fetchText(url.href, 'application/json', signal));
  if (!Array.isArray(json.query?.search))
    throw Error('The reference service returned an unsupported response.');
  return {
    service: 'Wikipedia reference search',
    retrievedAt: new Date().toISOString(),
    results: json.query.search.map((x: { title: string; snippet: string; pageid: number }) => ({
      title: x.title,
      url: source + '/?curid=' + x.pageid,
      snippet: String(x.snippet).replace(/<[^>]*>/g, ''),
    })),
  };
}

/** Read a public web page as text, in bounded windows.
 *
 * `untrusted` is part of the payload on purpose: page content is attacker
 * controlled, and the model is told so every time rather than once in a prompt.
 */
export async function readPublicPage(
  rawUrl: unknown,
  offset: unknown,
  signal: AbortSignal,
): Promise<{
  source: string;
  service: string;
  retrievedAt: string;
  content: string;
  nextOffset: number | null;
  totalCharacters: number;
  untrusted: true;
}> {
  const source = publicPageUrl(rawUrl);
  const start = offset ?? 0;
  if (!Number.isInteger(start) || (start as number) < 0 || (start as number) > 250000)
    throw Error('Invalid page offset.');
  const body = await fetchText('https://r.jina.ai/' + source, 'text/plain', signal);
  const from = start as number;
  return {
    source,
    service: 'Jina Reader · public page',
    retrievedAt: new Date().toISOString(),
    content: body.slice(from, from + PAGE_WINDOW),
    nextOffset: from + PAGE_WINDOW < body.length ? from + PAGE_WINDOW : null,
    totalCharacters: body.length,
    untrusted: true,
  };
}
