import { redactJson } from './redact-secrets.ts';
import { publicPageUrl } from './web-tools';

type SearchRow = { title?: unknown; url?: unknown; content?: unknown; description?: unknown };
export async function searchWeb(
  query: unknown,
  signal: AbortSignal,
  savedKey?: () => Promise<string>,
) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300)
    throw Error('Enter a web query up to 300 characters.');
  const endpoint = process.env.HIKMAH_SEARCH_URL;
  const key =
    !endpoint && savedKey
      ? (await savedKey()) || process.env.BRAVE_SEARCH_API_KEY
      : process.env.BRAVE_SEARCH_API_KEY;
  if (!endpoint && !key)
    throw Error(
      'Web search is unavailable. Configure HIKMAH_SEARCH_URL (SearXNG) or BRAVE_SEARCH_API_KEY on the server, or use a connected search tool.',
    );
  // Only an operator-configured endpoint is used. The model cannot choose a host.
  const target = new URL(endpoint || 'https://api.search.brave.com/res/v1/web/search');
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw Error('Invalid server search endpoint.');
  target.searchParams.set('q', query.trim());
  if (endpoint) target.searchParams.set('format', 'json');
  else {
    target.searchParams.set('count', '6');
    target.searchParams.set('safesearch', 'moderate');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!endpoint && key) headers['X-Subscription-Token'] = key;
  const response = await fetch(target, { headers, signal, redirect: 'error', credentials: 'omit' });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      'Web search returned HTTP ' + response.status + '. No search evidence was retrieved.',
    );
  }
  if (!response.body) throw Error('Web search returned no data.');
  const reader = response.body.getReader();
  let body = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1_000_000) throw Error('Search response exceeded its size limit.');
      body += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  body += decoder.decode();
  if (!endpoint && key) body = redactJson(body, [key]);
  const json = JSON.parse(body);
  const rows: SearchRow[] = endpoint ? json.results : json.web?.results;
  if (!Array.isArray(rows)) throw Error('Search service returned an unsupported response.');
  const results = rows
    .slice(0, 20)
    .flatMap((row) => {
      try {
        const url = publicPageUrl(row.url);
        return [
          {
            title: String(row.title ?? url).slice(0, 300),
            url,
            snippet: String(row.content ?? row.description ?? '')
              .replace(/<[^>]*>/g, '')
              .slice(0, 1800),
          },
        ];
      } catch {
        return [];
      }
    })
    .slice(0, 6);
  return {
    service: endpoint ? 'SearXNG web search' : 'Brave web search',
    query,
    retrievedAt: new Date().toISOString(),
    results,
    untrusted: true,
    note: 'Search snippets are discovery leads. Read source pages before claiming verification.',
  };
}
