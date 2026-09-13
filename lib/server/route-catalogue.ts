/** OpenRouter's public model list, kept for an hour.
 *
 * Read for two things: the price of a model a direct provider listed without
 * one, and the picker for an OpenRouter connection with no key saved yet. It
 * needs no key and changes rarely, and every relay request re-fetching a
 * 400-row catalogue would be the slowest part of opening the picker.
 */
import { normalizeModel, type ModelInfo } from '../playground/model-catalog.ts';

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 8_000_000;

let cached: { at: number; models: ModelInfo[] } | undefined;
let inflight: Promise<ModelInfo[]> | undefined;

/** The cached listing, refreshed when it is older than an hour. A fetch that
 * fails leaves the last good listing in place. */
export function routeCatalogue(
  signal?: AbortSignal,
  doFetch: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ModelInfo[]> {
  if (cached && now() - cached.at < TTL_MS) return Promise.resolve(cached.models);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await doFetch(CATALOGUE_URL, {
        signal,
        headers: { Accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('catalogue ' + response.status);
      if (Number(response.headers.get('content-length')) > MAX_BYTES)
        throw new Error('catalogue too large');
      const data = (await response.json()) as { data?: unknown[] };
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map(normalizeModel)
        .filter((model): model is ModelInfo => model !== null);
      cached = { at: now(), models };
      return models;
    } catch (error) {
      if (cached) return cached.models;
      throw error;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** For the tests: forget what was fetched. */
export function resetRouteCatalogue(): void {
  cached = undefined;
  inflight = undefined;
}
