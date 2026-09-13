/** What Ollama knows about a model that its OpenAI-compatible list leaves out.
 *
 * `GET /v1/models` on an Ollama server — the one on this machine or
 * ollama.com — answers with ids and nothing else, so every Ollama model showed
 * in the picker without a context length, without its tools and thinking
 * chips, and vanished under the Tools filter. Ollama's own `POST /api/show`
 * has all of it: capabilities (`tools`, `thinking`, `vision`), the context
 * length under `model_info["<architecture>.context_length"]`, and the size.
 * ollama.com answers it without a key.
 *
 * One request per model, a few at a time, bounded by a deadline, and kept for
 * an hour, so opening the picker twice does not ask twenty times twice. Best
 * effort throughout: a model whose details did not arrive keeps its bare row,
 * and a server that has no `/api/show` at all is simply not Ollama.
 */
import { providerFor } from '../ai/providers.ts';
import type { ModelInfo } from '../playground/model-catalog.ts';

const TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 1000;
/** How many models are asked about per listing, and how many at once. */
const MAX_MODELS = 150;
const CONCURRENCY = 6;
const SHOW_TIMEOUT_MS = 8000;
const DEADLINE_MS = 25_000;
const MAX_BYTES = 2_000_000;

export type OllamaDetails = {
  capabilities: string[];
  contextLength?: number;
  parameterSize?: string;
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** Where Ollama's native API is for this OpenAI-compatible base URL, or
 * undefined when the endpoint is not Ollama's. A preset says so by name; a
 * custom server is recognised by the listing it gave — Ollama marks every row
 * `owned_by: "library"` (local) or `"ollama"` (cloud), and nothing else does. */
export function ollamaApiFor(baseUrl: string, rows: readonly unknown[]): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (!/\/v1\/?$/.test(url.pathname)) return undefined;
  const preset = providerFor(baseUrl);
  const ollama = preset
    ? preset.id === 'ollama' || preset.id === 'ollama-cloud'
    : rows.length > 0 &&
      rows.every(
        (row) => isRecord(row) && (row.owned_by === 'library' || row.owned_by === 'ollama'),
      );
  if (!ollama) return undefined;
  return url.origin + url.pathname.replace(/\/v1\/?$/, '') + '/api';
}

/** The details in one `/api/show` answer, or undefined when it is not one. */
export function detailsFromShow(raw: unknown): OllamaDetails | undefined {
  if (!isRecord(raw)) return undefined;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string' && c.length <= 40)
    : [];
  const info = isRecord(raw.model_info) ? raw.model_info : {};
  const architecture = info['general.architecture'];
  let context =
    typeof architecture === 'string' ? info[architecture + '.context_length'] : undefined;
  if (context === undefined)
    for (const [key, value] of Object.entries(info))
      if (key.endsWith('.context_length')) context = value;
  const details = isRecord(raw.details) ? raw.details : {};
  const size = details.parameter_size;
  const out: OllamaDetails = { capabilities: capabilities.slice(0, 20) };
  if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0)
    out.contextLength = context;
  if (typeof size === 'string' && size && size.length <= 40) out.parameterSize = size;
  if (!out.capabilities.length && !out.contextLength && !out.parameterSize) return undefined;
  return out;
}

/** The rows with what Ollama said about each. A capability the server lists
 * is stated; one it does not list is left unknown rather than denied, since
 * an older server lists none at all. */
export function withOllamaDetails(
  models: readonly ModelInfo[],
  details: ReadonlyMap<string, OllamaDetails>,
): ModelInfo[] {
  return models.map((model) => {
    const found = details.get(model.id);
    if (!found) return model;
    const merged: ModelInfo = { ...model, metadata_source: 'ollama' };
    if (merged.context_length === undefined && found.contextLength)
      merged.context_length = found.contextLength;
    if (found.capabilities.length) {
      merged.tools = found.capabilities.includes('tools');
      merged.reasoning = found.capabilities.includes('thinking');
      merged.vision = found.capabilities.includes('vision');
    }
    return merged;
  });
}

const cache = new Map<string, { at: number; details: OllamaDetails | null }>();

function remember(key: string, details: OllamaDetails | null, now: number) {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: now, details });
}

/** Details for these models from this server, from the cache where it has
 * them and from `/api/show` otherwise. Never throws: what did not arrive by
 * the deadline is left out. */
export async function ollamaDetails(
  api: string,
  ids: readonly string[],
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    doFetch?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<Map<string, OllamaDetails>> {
  const doFetch = options.doFetch ?? fetch;
  const now = options.now ?? Date.now;
  const result = new Map<string, OllamaDetails>();
  const missing: string[] = [];
  for (const id of ids.slice(0, MAX_MODELS)) {
    const hit = cache.get(api + '\n' + id);
    if (hit && now() - hit.at < TTL_MS) {
      if (hit.details) result.set(id, hit.details);
    } else missing.push(id);
  }
  if (!missing.length) return result;
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signals = options.signal ? [options.signal, deadline] : [deadline];
  const show = async (id: string) => {
    const signal = AbortSignal.any([...signals, AbortSignal.timeout(SHOW_TIMEOUT_MS)]);
    try {
      const response = await doFetch(api + '/show', {
        method: 'POST',
        body: JSON.stringify({ model: id }),
        headers: {
          ...options.headers,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
        void response.body?.cancel().catch(() => {});
        // A model the server does not know is not asked about again this hour.
        if (response.status === 404) remember(api + '\n' + id, null, now());
        return;
      }
      const details = detailsFromShow(await response.json());
      remember(api + '\n' + id, details ?? null, now());
      if (details) result.set(id, details);
    } catch {
      /* left bare */
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < missing.length && !deadline.aborted && !options.signal?.aborted)
      await show(missing[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return result;
}

/** For the tests: forget what was fetched. */
export function resetOllamaDetails(): void {
  cache.clear();
}
