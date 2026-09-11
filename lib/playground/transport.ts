import { parseSecretRef } from './secret-reference.ts';
import { CompletionFramer, FramingError } from './completion-framing.ts';
/** OpenAI-compatible Chat Completions transport. Known providers use the app relay;
 * other compatible endpoints connect directly from the browser.
 * Plaintext keys remain in caller memory. Saved settings contain only vault references.
 * Protocol: https://openrouter.ai/docs/api_reference/streaming
 * Tools: https://openrouter.ai/docs/guides/features/tool-calling
 */
import {
  normalizeReasoningDetails,
  mergeReasoningDetails,
  readableExplanation,
  type ReasoningDetail,
} from './reasoning.ts';
import { relayProviderFor, RELAY_ERRORS, isRelayErrorCode } from './provider-routes.ts';
import {
  diagnoseProviderError,
  hasProviderError,
  type ProviderDiagnostic,
} from './provider-diagnostics.ts';
import { normalizeModel, type ModelInfo, type ReasoningEffort } from './model-catalog.ts';
export type { ModelInfo } from './model-catalog.ts';
export interface ProviderConfig {
  freeOnly?: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeySecret?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  customSampling?: boolean;
  reasoningEffort?: ReasoningEffort;
  stream?: boolean;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
}
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters: JsonSchema; strict?: boolean };
}
export interface MessageToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: MessageToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
}
export type ProviderMessage = ChatMessage;
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
}
export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  finishReason?: string;
  reasoning?: string;
  reasoningDetails?: ReasoningDetail[];
}
export interface CompleteOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Called with each new text fragment, never with cumulative content. */
  onText?: (delta: string) => void;
  onReasoning?: (text: string) => void;
  onMeta?: (metadata: { model: string; usage: Usage }) => void;
}
export type TransportErrorCode =
  'config' | 'request' | 'http' | 'network' | 'protocol' | 'limit' | 'aborted' | 'timeout';
export class ProviderTransportError extends Error {
  readonly code: TransportErrorCode;
  readonly status?: number;
  readonly diagnostic?: ProviderDiagnostic;
  constructor(
    code: TransportErrorCode,
    message: string,
    status?: number,
    diagnostic?: ProviderDiagnostic,
  ) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'ProviderTransportError';
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}
export const TRANSPORT_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  requestBytes: 4_000_000,
  responseBytes: 16_000_000,
  outputCharacters: 2_000_000,
  contentCharacters: 200_000,
  maxTokens: 131072,
});
function fail(code: TransportErrorCode, message: string): never {
  throw new ProviderTransportError(code, message);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const shortString = (value: unknown, max = 256): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
function isNonPublic(host: string): boolean {
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1).toLowerCase();
    // Only globally routed IPv6 unicast (2000::/3); reject private/mapped addresses.
    return !/^[23][0-9a-f]{0,3}:/.test(ip) || ip.startsWith('2001:db8:');
  }
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return !host.includes('.') || /\.(local|localhost|internal|invalid|test)$/.test(host);
}
function normalizeConfig(config: ProviderConfig, requireModel: boolean): ProviderConfig {
  if (!config || typeof config.baseUrl !== 'string')
    fail('config', 'Enter an OpenAI-compatible API base URL.');
  const raw = config.baseUrl.trim();
  if (!/^https?:\/\//i.test(raw) || /[\s\\\u0000-\u001f\u007f]/.test(raw))
    fail('config', 'Use a valid HTTPS API base URL. Localhost may use HTTP.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('config', 'Enter a valid API base URL, such as https://openrouter.ai/api/v1.');
  }
  if (url.username || url.password || raw.includes('?') || raw.includes('#'))
    fail(
      'config',
      'Remove credentials, query parameters, and fragments from the API base URL. Put the API key in its own field.',
    );
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  } catch {
    return fail('config', 'The API base URL contains an invalid encoded path.');
  }
  if (/\/chat\/completions$/i.test(path))
    fail(
      'config',
      'Enter the API base URL only: remove /chat/completions. For OpenRouter use https://openrouter.ai/api/v1.',
    );
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const local = isLoopback(host);
  if (!local && (url.protocol !== 'https:' || isNonPublic(host)))
    fail(
      'config',
      'Use a public HTTPS API URL, or localhost HTTP for a compatible server running on this device.',
    );
  if (
    typeof config.apiKey !== 'string' ||
    /[\r\n\u0000-\u001f\u007f]/.test(config.apiKey) ||
    config.apiKey.length > 8192
  )
    fail('config', 'Enter a valid API key without line breaks.');
  const apiKey = config.apiKey.trim();
  if (apiKey.startsWith('sk-or-v1-') && url.origin + path !== 'https://openrouter.ai/api/v1')
    fail(
      'config',
      'This is an OpenRouter key. Choose OpenRouter and use https://openrouter.ai/api/v1.',
    );
  const apiKeySecret = parseSecretRef(config.apiKeySecret);
  if (config.apiKeySecret && (!apiKeySecret || !relayProviderFor(raw.replace(/\/+$/, ''))))
    fail(
      'config',
      'Saved keys support OpenRouter and Experiential. Choose a supported provider or use a session key for a custom endpoint.',
    );
  if (!local && !apiKey && !apiKeySecret)
    fail('config', 'Enter an API key or select a saved secret for this provider.');
  if (
    typeof config.model !== 'string' ||
    (requireModel && !shortString(config.model.trim())) ||
    config.model.length > 256
  )
    fail('config', 'Enter or select a model ID.');
  if (
    !Number.isInteger(config.maxTokens) ||
    config.maxTokens < 1 ||
    config.maxTokens > TRANSPORT_LIMITS.maxTokens
  )
    fail('config', 'Max tokens must be a whole number between 1 and 131072.');
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
    fail('config', 'Temperature must be between 0 and 2.');
  if (
    config.freeOnly &&
    requireModel &&
    (url.origin + path !== 'https://openrouter.ai/api/v1' ||
      !(
        config.model.trim() === 'openrouter/free' ||
        /^[A-Za-z0-9_./-]+:free$/.test(config.model.trim())
      ))
  )
    fail(
      'config',
      'Free-only mode blocks this model. Choose OpenRouter Free Router or an OpenRouter :free model.',
    );
  // Preserve custom path prefixes; append routes later without assuming /v1.
  if (config.customSampling !== undefined && typeof config.customSampling !== 'boolean')
    fail('config', 'Custom sampling must be on or off.');
  if (config.stream !== undefined && typeof config.stream !== 'boolean')
    fail('config', 'Streaming must be on or off.');
  if (
    config.tokenParameter !== undefined &&
    !['max_tokens', 'max_completion_tokens'].includes(config.tokenParameter)
  )
    fail('config', 'Choose a supported token parameter.');
  if (
    config.reasoningEffort !== undefined &&
    !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      config.reasoningEffort,
    )
  )
    fail('config', 'Choose a supported reasoning effort.');
  return {
    apiKeySecret,
    freeOnly: config.freeOnly === true,
    reasoningEffort: config.reasoningEffort ?? 'default',
    baseUrl: raw.replace(/\/+$/, ''),
    apiKey,
    model: config.model.trim(),
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    customSampling: config.customSampling === true,
    stream: config.stream !== false,
    tokenParameter: config.tokenParameter ?? 'max_tokens',
  };
}
export function validateConfig(config: ProviderConfig): ProviderConfig {
  return normalizeConfig(config, true);
}

function httpError(status: number): ProviderTransportError {
  const messages: Record<number, string> = {
    400: 'The provider rejected the request. Check the model ID, token limit, and supported tool parameters.',
    401: 'The provider rejected the API key. Check or replace it in provider settings.',
    402: 'The provider account needs credits or an updated billing setting.',
    403: 'The provider denied access. Check the key permissions and selected model.',
    404: 'The API route or model was not found. Check the API base URL and model ID.',
    405: 'This endpoint does not support this API operation. Check the API base URL.',
    408: 'The provider timed out. Try again with a shorter prompt.',
    413: 'The provider rejected the request size. Shorten the conversation.',
    429: 'The provider rate limit was reached. Wait briefly before trying again.',
  };
  return new ProviderTransportError(
    'http',
    messages[status] ??
      (status >= 500
        ? 'The provider is temporarily unavailable. Try again later.'
        : 'The provider rejected the request. Check provider settings.'),
    status,
  );
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new ProviderTransportError('aborted', 'Request cancelled.'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new ProviderTransportError('aborted', 'Request cancelled.'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
const activityTimers = new WeakMap<AbortSignal, () => void>();
async function request<T>(
  config: ProviderConfig,
  endpoint: string,
  body: string | undefined,
  source: AbortSignal | undefined,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const relay = relayProviderFor(config.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRANSPORT_LIMITS.timeoutMs);
  };
  touch();
  activityTimers.set(controller.signal, touch);
  source?.addEventListener('abort', abort, { once: true });
  if (source?.aborted) abort();
  try {
    if (controller.signal.aborted) fail('aborted', 'Request cancelled.');
    const headers: Record<string, string> = {
      Accept: body ? 'text/event-stream, application/json' : 'application/json',
    };
    if (config.apiKeySecret && relay) headers['X-Hikmah-Secret-Ref'] = config.apiKeySecret;
    else if (config.apiKey)
      headers[relay ? 'X-Hikmah-Provider-Key' : 'Authorization'] = relay
        ? config.apiKey
        : `Bearer ${config.apiKey}`;
    if (body && config.freeOnly) headers['X-Hikmah-Free-Only'] = 'true';
    if (body) headers['Content-Type'] = 'application/json';
    const target = relay
      ? `/api/provider?provider=${relay.id}&operation=${body ? 'chat' : 'models'}`
      : `${config.baseUrl}/${endpoint}`;
    const response = await abortable(
      fetch(target, {
        method: body ? 'POST' : 'GET',
        headers,
        body,
        signal: controller.signal,
        mode: relay ? 'same-origin' : 'cors',
        credentials: relay ? 'same-origin' : 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }),
      controller.signal,
    );
    if (!response.ok) {
      const relayCode = response.headers.get('X-Hikmah-Relay-Error');
      if (relay && isRelayErrorCode(relayCode)) {
        void response.body?.cancel().catch(() => {});
        throw new ProviderTransportError('http', RELAY_ERRORS[relayCode].message, response.status);
      }
      let data: unknown;
      try {
        let raw = '';
        await readBody(response, controller.signal, (chunk) => {
          raw += chunk;
          return raw.length <= 65536;
        });
        data = JSON.parse(raw);
      } catch {
        /* Never show untrusted bodies. */
      }
      if (hasProviderError(data)) {
        const d = diagnoseProviderError(data, response.status);
        const wait = Number(response.headers.get('Retry-After'));
        if (wait > 0 && wait <= 86400) d.retryAfterSeconds = Math.ceil(wait);
        throw new ProviderTransportError('http', d.message, response.status, d);
      }
      throw httpError(response.status);
    }
    if (response.redirected)
      fail('network', 'API redirects are disabled. Enter the provider’s final API base URL.');
    const declaredSize = Number(response.headers.get('content-length'));
    if (!body && declaredSize > TRANSPORT_LIMITS.responseBytes)
      fail('limit', 'The provider JSON response exceeds 16 MB. Use streaming for long answers.');
    return await consume(response, controller.signal);
  } catch (error) {
    // Never include raw network/provider errors: they may echo credentials or prompts.
    if (timedOut)
      throw new ProviderTransportError(
        'timeout',
        'The provider sent no data for 5 minutes. Your partial answer is preserved; you can continue the task.',
      );
    if (source?.aborted) throw new ProviderTransportError('aborted', 'Request cancelled.');
    if (error instanceof ProviderTransportError) throw error;
    throw new ProviderTransportError(
      'network',
      relay
        ? 'The browser could not reach the app’s server connection. Reload the playground and check your network. No automatic retry was made.'
        : 'The browser could not reach this custom provider. Check the URL and its browser CORS support. Local servers must allow this app’s origin.',
    );
  } finally {
    clearTimeout(timer!);
    activityTimers.delete(controller.signal);
    source?.removeEventListener('abort', abort);
    controller.abort();
  }
}
async function readBody(
  response: Response,
  signal: AbortSignal,
  onChunk: (text: string) => boolean | void,
  maxBytes: number = TRANSPORT_LIMITS.responseBytes,
): Promise<void> {
  if (!response.body) fail('protocol', 'The provider returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        onChunk(decoder.decode());
        return;
      }
      bytes += value.byteLength;
      if (value.byteLength) activityTimers.get(signal)?.();
      if (bytes > maxBytes)
        fail('limit', 'The provider JSON response exceeds 16 MB. Use streaming for long answers.');
      if (onChunk(decoder.decode(value, { stream: true })) === false) return;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(
      'protocol',
      'The provider returned invalid JSON. Check that the URL serves an OpenAI-compatible API.',
    );
  }
}
function providerFailure(data: unknown): void {
  if (isRecord(data) && hasProviderError(data)) {
    const code = isRecord(data.error) && typeof data.error.code === 'string' ? data.error.code : '';
    if (code.startsWith('relay_') && isRelayErrorCode(code.slice(6))) {
      const relayCode = code.slice(6) as keyof typeof RELAY_ERRORS;
      fail(
        relayCode === 'timeout' ? 'timeout' : relayCode === 'limit' ? 'limit' : 'network',
        RELAY_ERRORS[relayCode].message,
      );
    }
    const d = diagnoseProviderError(data);
    throw new ProviderTransportError('protocol', d.message, undefined, d);
  }
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  let text = '';
  await readBody(response, signal, (chunk) => {
    text += chunk;
  });
  const data = parseJson(text);
  providerFailure(data);
  return data;
}
export async function listModels(
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const validated = normalizeConfig(config, false);
  return request(validated, 'models', undefined, signal, async (response, requestSignal) => {
    const data = await readJson(response, requestSignal);
    if (!isRecord(data) || !Array.isArray(data.data))
      fail(
        'protocol',
        'The provider did not return an OpenAI-compatible model list. Enter the model ID manually.',
      );
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of data.data) {
      const model = normalizeModel(item);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models;
  });
}
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || !messages.length || messages.length > 256)
    fail('request', 'Send between 1 and 256 conversation messages.');
  let total = 0;
  return messages.map((message) => {
    if (
      !message ||
      !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      (message.content !== null && typeof message.content !== 'string')
    )
      fail('request', 'Conversation messages must use supported roles and text content.');
    total += message.content?.length ?? 0;
    if (total > TRANSPORT_LIMITS.contentCharacters)
      fail('limit', 'The conversation exceeds 200,000 characters. Start a shorter conversation.');
    const normalized: ChatMessage = { role: message.role, content: message.content };
    if (message.role === 'assistant') {
      if (message.reasoning !== undefined) {
        if (typeof message.reasoning !== 'string' || message.reasoning.length > 200000)
          fail('request', 'Invalid provider explanation.');
        normalized.reasoning = message.reasoning;
        total += message.reasoning.length;
      }
      normalized.reasoning_details = normalizeReasoningDetails(message.reasoning_details);
      total += JSON.stringify(normalized.reasoning_details ?? []).length;
      if (total > TRANSPORT_LIMITS.contentCharacters)
        fail('limit', 'Conversation including provider explanation exceeds the available context.');
    }
    if (message.name !== undefined) {
      if (!shortString(message.name, 128))
        fail('request', 'A conversation message has an invalid name.');
      normalized.name = message.name;
    }
    if (message.role === 'tool') {
      if (!shortString(message.tool_call_id, 65536))
        fail('request', 'A tool result must reference its tool call ID.');
      normalized.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls !== undefined) {
      if (
        message.role !== 'assistant' ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length > 64
      )
        fail('request', 'Tool calls must belong to an assistant message.');
      normalized.tool_calls = message.tool_calls.map((call) => {
        if (
          !call ||
          call.type !== 'function' ||
          !shortString(call.id, 65536) ||
          !call.function ||
          !shortString(call.function.name, 128) ||
          typeof call.function.arguments !== 'string'
        )
          fail('request', 'A conversation tool call is invalid.');
        total += call.function.arguments.length + call.id.length;
        if (total > TRANSPORT_LIMITS.contentCharacters)
          fail(
            'limit',
            'The conversation exceeds 200,000 characters. Start a shorter conversation.',
          );
        return {
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        };
      });
    }
    return normalized;
  });
}
function normalizeTools(tools: ToolDefinition[] | undefined): ToolDefinition[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length > 64)
    fail('request', 'Provide at most 64 function tools.');
  return tools.map((tool) => {
    if (
      !tool ||
      tool.type !== 'function' ||
      !tool.function ||
      !shortString(tool.function.name, 128) ||
      !isRecord(tool.function.parameters)
    )
      fail('request', 'Tools must include a function name and a JSON schema object.');
    const fn: ToolDefinition['function'] = {
      name: tool.function.name,
      parameters: tool.function.parameters,
    };
    if (tool.function.description !== undefined) {
      if (
        typeof tool.function.description !== 'string' ||
        tool.function.description.length > 20_000
      )
        fail('request', 'A tool description is invalid or too long.');
      fn.description = tool.function.description;
    }
    if (tool.function.strict !== undefined) {
      if (typeof tool.function.strict !== 'boolean')
        fail('request', 'A tool schema has an invalid strict setting.');
      fn.strict = tool.function.strict;
    }
    return { type: 'function', function: fn };
  });
}

/** Shared validation also runs on the server; client-side checks are not an API boundary. */
export function createCompletionBody(
  config: ProviderConfig,
  messages: ChatMessage[],
  requestedTools?: ToolDefinition[],
): string {
  const validated = validateConfig(config);
  const payload: Record<string, unknown> = {
    model: validated.model,
    messages: normalizeMessages(messages),
    [validated.tokenParameter ?? 'max_tokens']: validated.maxTokens,
    stream: validated.stream !== false,
  };
  if (validated.freeOnly)
    payload.provider = { max_price: { prompt: 0, completion: 0, request: 0 } };
  if (validated.customSampling) payload.temperature = validated.temperature;
  if (validated.reasoningEffort && validated.reasoningEffort !== 'default') {
    if (new URL(validated.baseUrl).hostname === 'openrouter.ai')
      payload.reasoning = { effort: validated.reasoningEffort, exclude: false };
    else payload.reasoning_effort = validated.reasoningEffort;
  }
  const tools = normalizeTools(requestedTools);
  if (tools?.length) payload.tools = tools;
  // Do not send provider-specific usage parameters to arbitrary compatibility endpoints.
  if (
    validated.stream !== false &&
    new URL(validated.baseUrl).hostname.toLowerCase() === 'openrouter.ai'
  )
    payload.stream_options = { include_usage: true };
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return fail('request', 'Messages and tool schemas must be serializable JSON.');
  }
  if (new TextEncoder().encode(body).byteLength > TRANSPORT_LIMITS.requestBytes)
    fail('limit', 'The request exceeds 4 MB. Shorten the conversation or tool schemas.');
  return body;
}
export async function complete(
  config: ProviderConfig,
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<CompletionResult> {
  const validated = validateConfig(config);
  const body = createCompletionBody(validated, messages, options.tools);
  return request(validated, 'chat/completions', body, options.signal, async (response, signal) => {
    const result: CompletionResult = {
      content: '',
      toolCalls: [],
      usage: {},
      model: validated.model,
    };
    const calls = new Map<number, ToolCall>();
    let outputCharacters = 0;
    let lastMetadata = '';
    let receivedChoice = false;
    let finished = false;
    let doneMarker = false;
    const append = (value: string): void => {
      outputCharacters += value.length;
      if (outputCharacters > TRANSPORT_LIMITS.outputCharacters)
        fail(
          'limit',
          'This answer reached the 2 million character display limit. Your partial answer is saved; continue in another message.',
        );
    };
    const ingest = (data: unknown, streaming: boolean): void => {
      providerFailure(data);
      if (!isRecord(data)) fail('protocol', 'The provider returned an invalid completion object.');
      if (shortString(data.model)) result.model = data.model;
      if (isRecord(data.usage)) {
        const details = data.usage.completion_tokens_details;
        if (
          isRecord(details) &&
          typeof details.reasoning_tokens === 'number' &&
          Number.isSafeInteger(details.reasoning_tokens) &&
          details.reasoning_tokens >= 0
        )
          result.usage.reasoning_tokens = details.reasoning_tokens;
        if (
          typeof data.usage.cost === 'number' &&
          Number.isFinite(data.usage.cost) &&
          data.usage.cost >= 0
        )
          result.usage.cost = data.usage.cost;
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
          const value = data.usage[key];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
            result.usage[key] = value;
        }
      }
      const metadata = JSON.stringify([result.model, result.usage]);
      if (metadata !== lastMetadata) {
        lastMetadata = metadata;
        options.onMeta?.({ model: result.model, usage: { ...result.usage } });
      }
      if (!Array.isArray(data.choices))
        fail('protocol', 'The provider did not return OpenAI-compatible completion choices.');
      const choice = data.choices.find(
        (value) => isRecord(value) && (value.index === 0 || value.index === undefined),
      );
      if (choice === undefined && streaming && data.choices.length === 0) return;
      if (!isRecord(choice)) fail('protocol', 'The provider did not return a completion choice.');
      providerFailure(choice);
      if (choice.finish_reason === 'error')
        fail('protocol', 'The provider reported an error while generating the answer.');
      if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
      if (choice.finish_reason === 'content_filter')
        fail('protocol', 'The provider filtered this response.');
      if (typeof choice.finish_reason === 'string') finished = true;
      const message = streaming ? choice.delta : choice.message;
      if (!isRecord(message))
        fail('protocol', 'The provider returned an invalid completion message.');
      receivedChoice = true;
      const explanation =
        typeof message.reasoning === 'string'
          ? message.reasoning
          : typeof message.reasoning_content === 'string'
            ? message.reasoning_content
            : undefined;
      if (explanation !== undefined) {
        append(explanation);
        result.reasoning = (result.reasoning ?? '') + explanation;
      }
      if (message.reasoning_details !== undefined) {
        const parts = normalizeReasoningDetails(message.reasoning_details)!;
        append(JSON.stringify(parts));
        result.reasoningDetails = streaming
          ? mergeReasoningDetails(result.reasoningDetails ?? [], parts)
          : parts;
      }
      if (explanation !== undefined || message.reasoning_details !== undefined)
        options.onReasoning?.(readableExplanation(result.reasoning, result.reasoningDetails));
      if (message.content !== undefined && message.content !== null) {
        if (typeof message.content !== 'string')
          fail('protocol', 'This playground supports text completion content only.');
        append(message.content);
        result.content += message.content;
        if (message.content) options.onText?.(message.content);
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls))
          fail('protocol', 'The provider returned invalid tool calls.');
        for (const [position, rawCall] of message.tool_calls.entries()) {
          if (!isRecord(rawCall) || (rawCall.type !== undefined && rawCall.type !== 'function'))
            fail('protocol', 'The provider returned an unsupported tool call.');
          const index = streaming ? rawCall.index : position;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 64)
            fail('protocol', 'The provider returned an invalid tool call index.');
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (rawCall.id !== undefined) {
            if (!shortString(rawCall.id, 65536))
              fail('protocol', 'The provider returned an invalid tool call ID.');
            if (call.id && call.id !== rawCall.id)
              fail('protocol', 'The provider changed a tool call ID during streaming.');
            call.id = rawCall.id;
          }
          if (rawCall.function !== undefined) {
            if (!isRecord(rawCall.function))
              fail('protocol', 'The provider returned an invalid function call.');
            if (rawCall.function.name !== undefined) {
              if (typeof rawCall.function.name !== 'string')
                fail('protocol', 'The provider returned an invalid function name.');
              call.name += rawCall.function.name;
              if (call.name.length > 128)
                fail('limit', 'The provider returned an overlong function name.');
            }
            if (rawCall.function.arguments !== undefined) {
              if (typeof rawCall.function.arguments !== 'string')
                fail('protocol', 'The provider returned non-text tool arguments.');
              append(rawCall.function.arguments);
              call.arguments += rawCall.function.arguments;
            }
          }
          calls.set(index, call);
        }
      }
    };
    let streamedRecords = false;
    const parser = new CompletionFramer((data, streaming) => {
      streamedRecords ||= streaming;
      ingest(data, streaming);
    });
    try {
      await readBody(response, signal, (text) => parser.feed(text), Number.POSITIVE_INFINITY);
      const framing = parser.finish();
      doneMarker = framing.done;
      if ((framing.streaming || streamedRecords) && !doneMarker && !finished)
        fail(
          'protocol',
          'The provider stream ended before completion. Your partial answer is preserved.',
        );
    } catch (error) {
      if (error instanceof FramingError) fail('protocol', error.message);
      throw error;
    }
    if (!receivedChoice) fail('protocol', 'The provider returned no completion choices.');
    if (result.finishReason === 'length' && calls.size)
      fail(
        'limit',
        'The model returned an incomplete tool call at its output limit. Increase output tokens and continue; no partial tool was executed.',
      );
    result.toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => {
        if (!shortString(call.id, 65536) || !shortString(call.name, 128))
          fail('protocol', 'The provider returned an incomplete tool call.');
        // Never execute tools here. The caller validates names/arguments and decides execution.
        return call;
      });
    return result;
  });
}
