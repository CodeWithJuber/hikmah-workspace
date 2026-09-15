/** Server-side provider registry.
 *
 * Replaces the browser transport's direct provider calls. Two things change by
 * moving here, and both are the point:
 *
 *  1. Keys never reach the browser. The previous design could only keep a key
 *     server-side for the two relay presets; a custom OpenAI-compatible
 *     endpoint had to hold its key in page memory and lost it on every reload.
 *  2. A base URL is now an SSRF surface, so it goes through `lib/ai/endpoint`
 *     rather than the looser checks a browser fetch needed.
 *
 * Free-only enforcement, the inactivity watchdog and the refusal to surface raw
 * provider prose are carried over unchanged: they are the properties that make
 * an unattended agent loop safe to run.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { providerFor } from './providers.ts';
import type { LanguageModel } from 'ai';
import { assertModelAllowed, resolveProviderBaseUrl } from './endpoint.ts';
import { providerMaxMs, withIdleTimeout } from './watchdog.ts';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export type ModelRequest = {
  baseUrl: string;
  model: string;
  apiKey: string;
  freeOnly?: boolean;
  /** Sent so OpenRouter attributes traffic to this deployment. */
  referer?: string;
  title?: string;
};

/**
 * Build a language model for one request.
 *
 * Deliberately not cached: the key, the endpoint and the free-only setting are
 * all per-owner state that can change between runs, and a cached provider would
 * keep using a key the owner has since rotated or revoked.
 */
export function createLanguageModel(request: ModelRequest): LanguageModel {
  const baseUrl = resolveProviderBaseUrl(request.baseUrl);
  const model = request.model.trim();
  assertModelAllowed({ baseUrl, model, freeOnly: request.freeOnly });
  // Read per call, not at import: a deployment sets HIKMAH_RUN_MAX_MS in its
  // environment, and the tests set it around individual cases.
  const fetchWithWatchdog = withIdleTimeout(undefined, undefined, providerMaxMs());

  if (baseUrl === OPENROUTER_BASE_URL) {
    const openrouter = createOpenRouter({
      apiKey: request.apiKey,
      headers: attribution(request),
      fetch: fetchWithWatchdog,
    });
    return openrouter.chat(model);
  }

  // Anthropic's Messages API is not the OpenAI protocol; its own provider
  // speaks it, tool calling and streaming included.
  if (providerFor(baseUrl)?.auth === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: request.apiKey,
      baseURL: baseUrl,
      headers: attribution(request),
      fetch: fetchWithWatchdog,
    });
    return anthropic.messages(model);
  }

  // Any other OpenAI-compatible server, including a self-hosted Ollama or vLLM
  // that the operator allow-listed. includeUsage keeps token counts on streamed
  // responses so the cost display has something truthful to show.
  const provider = createOpenAICompatible({
    name: 'hikmah-openai-compatible',
    baseURL: baseUrl,
    apiKey: request.apiKey || undefined,
    headers: attribution(request),
    includeUsage: true,
    fetch: fetchWithWatchdog,
  });
  return provider.chatModel(model);
}

function attribution(request: ModelRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (request.referer) headers['HTTP-Referer'] = request.referer;
  if (request.title) headers['X-Title'] = request.title;
  return headers;
}
