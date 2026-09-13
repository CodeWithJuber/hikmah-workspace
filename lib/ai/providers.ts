/** The providers the chat can talk to, in one list.
 *
 * Every hosted provider here speaks the OpenAI chat-completions protocol —
 * OpenAI, Kimi (Moonshot), DeepSeek, Groq, Mistral, xAI and Google's
 * OpenAI-compatible endpoint natively, OpenRouter for all of them at once —
 * except Anthropic, whose Messages API is spoken through its own AI SDK
 * provider. Ollama is the one local entry: no key, plain HTTP, every model
 * free because none of them is billed.
 *
 * Pure and browser-safe: the settings screen reads it to offer the presets,
 * the relay reads it to know which hosts it may forward to and how each one
 * wants its key, and the model factory reads it to pick the SDK. One list, so
 * adding a provider is one entry and not four edits that drift.
 */

export type ProviderAuth = 'bearer' | 'anthropic' | 'none';

export type ProviderPreset = {
  /** Stable id: the relay's `provider=` parameter and the vault destination. */
  id: string;
  name: string;
  baseUrl: string;
  /** How the key travels. Anthropic wants `x-api-key` and a version header. */
  auth: ProviderAuth;
  /** Where a person gets a key. */
  keyUrl?: string;
  /** Whether `GET /models` answers without a key (OpenRouter's does). */
  publicCatalogue?: boolean;
  /** Whether the provider has models that cost nothing. Only OpenRouter's
   * `:free` routes and a local server; every other hosted provider bills every
   * token to the key. */
  freeTier: boolean;
  /** Which of its models "free models only" admits: OpenRouter's by their
   * `:free` suffix; Ollama's, local or cloud, all of them — the cloud is free
   * within its usage limits and lists no prices to filter by. */
  freeModels?: 'suffix' | 'all';
  /** The vendor prefix OpenRouter lists this provider's models under, so a
   * model listed by the provider without a price can be shown OpenRouter's
   * public price for the same model as an estimate. */
  routeVendor?: string;
  /** The run reaches it on this machine, not over the internet. */
  local?: boolean;
  /** One line under the endpoint field. */
  note?: string;
};

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
/** Ollama on the Docker host, from inside the app's container. */
export const OLLAMA_DOCKER_URL = 'http://host.docker.internal:11434/v1';

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    keyUrl: 'https://openrouter.ai/keys',
    publicCatalogue: true,
    freeTier: true,
    freeModels: 'suffix',
    note: 'Hundreds of models behind one key, with a free tier. Prices are listed per model.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: OLLAMA_BASE_URL,
    auth: 'none',
    freeTier: true,
    freeModels: 'all',
    local: true,
    note: 'Models on this machine. No key; the list fills from what is installed.',
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    auth: 'bearer',
    keyUrl: 'https://ollama.com/settings/keys',
    publicCatalogue: true,
    freeTier: true,
    freeModels: 'all',
    note: 'Ollama’s hosted models (Kimi, DeepSeek, Qwen, gpt-oss and more) behind one key. Free within Ollama’s usage limits.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    freeTier: false,
    routeVendor: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    freeTier: false,
    routeVendor: 'anthropic',
  },
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    auth: 'bearer',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    freeTier: false,
    routeVendor: 'moonshotai',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'bearer',
    keyUrl: 'https://aistudio.google.com/apikey',
    freeTier: false,
    routeVendor: 'google',
    note: 'Through Google’s OpenAI-compatible endpoint.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    auth: 'bearer',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    freeTier: false,
    routeVendor: 'deepseek',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'bearer',
    keyUrl: 'https://console.groq.com/keys',
    freeTier: false,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'bearer',
    keyUrl: 'https://console.mistral.ai/api-keys',
    freeTier: false,
    routeVendor: 'mistralai',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    auth: 'bearer',
    keyUrl: 'https://console.x.ai',
    freeTier: false,
    routeVendor: 'x-ai',
  },
  {
    id: 'experiential',
    name: 'Experiential Labs',
    baseUrl: 'https://api.experientiallabs.ai/v1',
    auth: 'bearer',
    freeTier: false,
  },
];

/** The base URL as the relay and the run compare it: origin plus path, no
 * trailing slash, no credentials, query or fragment. */
function normaliseBaseUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** The preset for a base URL, or undefined for a custom endpoint. */
export function providerFor(baseUrl: string): ProviderPreset | undefined {
  const normalised = normaliseBaseUrl(baseUrl);
  return normalised ? PROVIDERS.find((provider) => provider.baseUrl === normalised) : undefined;
}

/** The hosted presets: what the server will forward to. A local endpoint is
 * not forwarded by name — it is reached under the run's own endpoint policy,
 * like any custom one. */
export function hostedProviders(): ProviderPreset[] {
  return PROVIDERS.filter((provider) => !provider.local);
}

/**
 * Where the vault keeps this endpoint's key.
 *
 * One name per provider, so a person with an OpenRouter key and an Anthropic
 * key keeps both and switches between them; one name for every custom HTTPS
 * endpoint, because they are rarely more than one. OpenRouter keeps the name
 * the vault has used since the setting existed, so a key already saved goes
 * on working.
 */
export function secretNameFor(baseUrl: string): string {
  const provider = providerFor(baseUrl);
  if (provider?.id === 'openrouter') return 'CHAT_PROVIDER_KEY';
  if (provider) return 'CHAT_PROVIDER_KEY_' + provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return 'CHAT_PROVIDER_KEY_CUSTOM';
}

/** The request headers that carry a key to this provider. */
export function authHeaders(auth: ProviderAuth, key: string): Record<string, string> {
  if (!key || auth === 'none') return {};
  if (auth === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}
