/** Explicit destinations only. An arbitrary URL must never become a server proxy. */
export const RELAY_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'experiential', name: 'Experiential Labs', baseUrl: 'https://api.experientiallabs.ai/v1' },
] as const;

export function relayProviderFor(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    return RELAY_PROVIDERS.find(provider => provider.baseUrl === normalized);
  } catch { return undefined; }
}

export const RELAY_ERRORS = {
  session: { status: 401, message: 'Your workspace sign-in has expired. Reload the app and sign in again, then select your saved secret or re-enter a session key.' },
  origin: { status: 403, message: 'The connection request must come from this workspace. Reload the app and try again.' },
  destination: { status: 400, message: 'This provider is not configured for the server connection. Choose a provider preset.' },
  request: { status: 400, message: 'The connection request is invalid. Check the model, token limit and conversation size.' },
  key: { status: 400, message: 'Select a saved secret assigned to this provider, or enter a valid session key in Settings → Connection.' },
  limit: { status: 413, message: 'The connection exceeded its size limit. Shorten the conversation or requested output.' },
  network: { status: 502, message: 'The app server could not reach the selected provider. Check the provider service status and try again.' },
  timeout: { status: 504, message: 'The provider connection timed out. Try a shorter prompt or another model.' },
  protocol: { status: 502, message: 'The provider returned an unsupported response. This connection requires OpenAI-compatible models and chat completions.' },
} as const;
export type RelayErrorCode = keyof typeof RELAY_ERRORS;
export function isRelayErrorCode(value: string | null): value is RelayErrorCode {
  return value !== null && Object.prototype.hasOwnProperty.call(RELAY_ERRORS, value);
}
