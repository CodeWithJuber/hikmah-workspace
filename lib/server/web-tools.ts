import { publicOrigin } from './origin.ts';
import { searchWeb } from './web-search';
import { researchQuran } from './quran-research';
import { UpstreamSourceError, readPublicPage, searchReference } from './public-sources.ts';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
export function publicPageUrl(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 2000) throw Error('Use a public HTTPS URL.');
  const u = new URL(raw);
  const h = u.hostname.toLowerCase();
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.hash ||
    u.port ||
    !h.includes('.') ||
    /^[0-9.]+$/.test(h) ||
    h.includes(':') ||
    /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(h)
  )
    throw Error('Use a public HTTPS page without credentials or a custom port.');
  return u.href;
}
export async function readBounded(
  r: { body: ReadableStream<Uint8Array> | null },
  signal: AbortSignal,
) {
  if (!r.body) throw Error('The source returned no content.');
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let out = '',
    size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1100000) throw Error('Page is too large to read. Choose a smaller source.');
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export async function webToolRequest(
  request: Request,
  authenticated: boolean,
  savedSearchKey?: () => Promise<string>,
) {
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
  if (!authenticated) return fail('Sign in to use web tools.', 401);
  const origin = publicOrigin(request);
  if (
    (request.headers.get('origin') !== origin &&
      request.headers.get('sec-fetch-site') !== 'same-origin') ||
    (request.headers.has('origin') && request.headers.get('origin') !== origin)
  )
    return fail('Use tools from your signed-in workspace.', 403);
  if (request.method !== 'POST') return fail('Unsupported method.', 405);
  try {
    const raw = await readBounded(request, request.signal);
    if (raw.length > 5000) return fail('Tool arguments are too large.', 400);
    const args = JSON.parse(raw);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
    if (args.tool === 'search_web')
      return Response.json(await searchWeb(args.query, signal, savedSearchKey), { headers });
    if (args.tool === 'research_quran')
      return Response.json(await researchQuran(args), { headers });
    if (args.tool === 'read_webpage')
      return Response.json(await readPublicPage(args.url, args.offset, signal), { headers });
    if (args.tool === 'search_reference')
      return Response.json(await searchReference(args.query, args.language, signal), { headers });
    return fail('Unknown web tool.', 400);
  } catch (e) {
    if (e instanceof UpstreamSourceError) return fail(e.message, e.status);
    return fail(
      e instanceof Error && e.name === 'TimeoutError'
        ? 'The source timed out. Try another source.'
        : e instanceof Error
          ? e.message
          : 'Web tool failed.',
      400,
    );
  }
}
