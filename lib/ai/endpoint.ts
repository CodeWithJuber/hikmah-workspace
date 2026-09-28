import { relayProviderFor } from '../playground/provider-routes.ts';
/** Endpoint policy for server-side provider calls.
 *
 * The browser transport validated a base URL because the browser was the one
 * making the request. Once the Node process calls providers on the owner's
 * behalf, the same URL becomes an SSRF vector: it is the server's network
 * position that a malicious or mistaken value now reaches, including the
 * container's own loopback, the compose network and any cloud metadata service.
 *
 * These are pure functions so the policy can be tested without a network.
 */
import {
  isAllowedPrivateHost,
  isLoopback,
  isNonPublic,
  parsePrivateAllowList,
} from './host-policy.ts';
import { providerFor } from './providers.ts';

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

export type EndpointPolicy = {
  /** Operator-declared private endpoints, from HIKMAH_PROVIDER_ALLOW_PRIVATE. */
  allowPrivate?: Set<string>;
};

/**
 * Validate and normalise a provider base URL for a server-side call.
 *
 * Rejects credentials, query strings and fragments in the URL (they are never
 * meaningful on a base URL and are a common smuggling trick), requires HTTPS
 * except for loopback, and refuses non-routable hosts unless the operator named
 * them explicitly. Returns the URL with any trailing slash removed so callers
 * can append routes without assuming `/v1`.
 */
export function resolveProviderBaseUrl(raw: string, policy: EndpointPolicy = {}): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new EndpointError('Enter the provider base URL.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new EndpointError('Enter a valid provider base URL, including https://.');
  }
  if (url.username || url.password)
    throw new EndpointError('Use a base URL without embedded credentials.');
  if (url.search || url.hash)
    throw new EndpointError('Use a base URL without a query string or fragment.');
  const host = url.hostname.toLowerCase();
  const loopback = isLoopback(host);
  const allowed =
    policy.allowPrivate ?? parsePrivateAllowList(process.env.HIKMAH_PROVIDER_ALLOW_PRIVATE);
  // A private host the operator named is a model server on the box or the
  // compose network — Ollama on the Docker host, vLLM beside it — and those
  // speak plain HTTP; nothing there has a certificate. Public hosts still must.
  const named = !loopback && isNonPublic(host) && isAllowedPrivateHost(url, allowed);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || named)))
    throw new EndpointError('Use an HTTPS provider URL. A local model server may use HTTP.');
  if (!loopback && isNonPublic(host) && !named)
    throw new EndpointError(
      `This provider host is not publicly routable. Add "${host}" to HIKMAH_PROVIDER_ALLOW_PRIVATE to allow a local model server on this network.`,
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Whether a model id is free on OpenRouter. */
export function isFreeOpenRouterModel(model: string): boolean {
  const id = model.trim();
  return id === 'openrouter/free' || /^[A-Za-z0-9_./-]+:free$/.test(id);
}

/**
 * Enforce the free-only setting, which is the app's default and its only
 * protection against an unattended agent loop spending real money. The check is
 * intentionally an allow-list of one origin plus a model-id shape: a paid model
 * on a custom OpenAI-compatible endpoint must not slip through because the
 * endpoint is unrecognised.
 */
export function assertModelAllowed(options: {
  baseUrl: string;
  model: string;
  freeOnly?: boolean;
}): void {
  if (!options.freeOnly) return;
  // A model server on this machine or the private network — Ollama, vLLM —
  // has no bill to run up: the setting exists to stop an unattended loop
  // spending money, and there is none to spend there. The URL has already
  // passed resolveProviderBaseUrl, so a private host here is one the operator
  // named.
  if (isLocalEndpoint(options.baseUrl)) return;
  // A provider whose every model is free within its limits — Ollama Cloud —
  // is admitted whole; it lists no prices to filter by.
  if (providerFor(options.baseUrl)?.freeModels === 'all') return;
  if (options.baseUrl !== 'https://openrouter.ai/api/v1' || !isFreeOpenRouterModel(options.model))
    throw new EndpointError(
      'This model is not free, but you have "Free models only" turned on. Pick a free model from the model menu below, or turn off "Free models only" in Settings.',
    );
}

/** Whether every model this endpoint lists counts as free: a local server, or
 * a provider whose models are free within its limits. The picker and the
 * catalogue filter read this; the run's rule above agrees with it. */
export function allModelsFree(baseUrl: string): boolean {
  return isLocalEndpoint(baseUrl) || providerFor(baseUrl)?.freeModels === 'all';
}

/** A loopback or private-network endpoint: one nobody is charged for. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    return isNonPublic(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Which saved-secret destination a base URL's key belongs to.
 *
 * The destination allowlist names a *provider* — `provider:openrouter` — and
 * these routes were building it from the model instead, producing strings like
 * `provider:deepseek/deepseek-chat:free` that no allowlist entry could match.
 * `validateDestination` threw, the caller's catch turned that into an empty
 * key, and the run failed against the provider with no key at all. A key the
 * owner had saved was never once used.
 *
 * Undefined for an endpoint that is not a known relay preset: a custom or local
 * endpoint has no shared destination to resolve against.
 */
export function providerDestination(baseUrl: string): string {
  const provider = relayProviderFor(baseUrl);
  if (provider) return 'provider:' + provider.id;
  // An endpoint with no preset still needs somewhere to keep its key. Bound to
  // the origin rather than the full URL: the path is a detail of the API, the
  // host is who the credential is for. A non-HTTPS endpoint is loopback or a
  // private address, which needs no key.
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' ? 'provider:' + url.origin : '';
  } catch {
    return '';
  }
}

/**
 * Would this run reach a provider with no credentials?
 *
 * A hosted endpoint answers 401 and the run dies for a reason the owner cannot
 * see, so it is refused up front instead. A private or loopback endpoint —
 * Ollama, vLLM, an OpenAI-compatible server on the same box — legitimately
 * needs no key, and refusing those would break the one setup that never had a
 * key to give.
 */
export function needsKey(baseUrl: string, apiKey: string): boolean {
  if (apiKey) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Not a URL at all. The request fails either way, and "no API key" is the
    // more useful of the two messages. Falling through to the host check would
    // read the empty host as private and let it queue.
    return true;
  }
  return !isNonPublic(host);
}
