import {publicOrigin} from './origin.ts';
import { RELAY_PROVIDERS, RELAY_ERRORS, type RelayErrorCode } from '../playground/provider-routes.ts';
import { createCompletionBody, TRANSPORT_LIMITS, type ChatMessage, type ToolDefinition } from '../playground/transport.ts';
import { diagnoseProviderError } from '../playground/provider-diagnostics.ts';
import { normalizeModel, enrichExperientialModels } from '../playground/model-catalog.ts';

const privateHeaders = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
class RelayFailure extends Error {
  code: RelayErrorCode;
  constructor(code: RelayErrorCode) { super(RELAY_ERRORS[code].message); this.code = code; }
}
export function relayFailure(code: RelayErrorCode): Response {
  return Response.json({ error: { code: `relay_${code}` } }, {
    status: RELAY_ERRORS[code].status,
    headers: { ...privateHeaders, 'X-Hikmah-Relay-Error': code },
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new RelayFailure('timeout')); };
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
async function boundedJson(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<unknown> {
  if (!body) throw new RelayFailure('request');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new RelayFailure('limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { void reader.cancel().catch(() => {}); }
}

/** Called only with identity resolved by the Site's server auth helper. Never logs
 * headers, request bodies, provider errors, or credentials. No retries or redirects. */
export async function relayProviderRequest(request: Request, authenticated: boolean): Promise<Response> {
  if (!authenticated) return relayFailure('session');
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== publicOrigin(request)) || (site && site !== 'same-origin') || (!origin && site !== 'same-origin')) return relayFailure('origin');
  const provider = RELAY_PROVIDERS.find(p => p.id === url.searchParams.get('provider'));
  const operation = url.searchParams.get('operation');
  if (!provider || !['models', 'chat'].includes(operation ?? '')) return relayFailure('destination');
  if (request.method !== (operation === 'chat' ? 'POST' : 'GET')) return relayFailure('request');
  const key = request.headers.get('X-Hikmah-Provider-Key')?.trim() ?? '';
  if (!key || key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key)) return relayFailure('key');
  if (operation === 'chat' && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return relayFailure('request');
  if (Number(request.headers.get('content-length')) > TRANSPORT_LIMITS.requestBytes) return relayFailure('limit');

  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer:ReturnType<typeof setTimeout>;const touch=()=>{clearTimeout(timer);timer=setTimeout(abort,TRANSPORT_LIMITS.timeoutMs);};touch();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const cleanup = () => { clearTimeout(timer!); request.signal.removeEventListener('abort', abort); controller.abort(); };
  let streaming = false;
  try {
    let body: string | undefined;
    if (operation === 'chat') {
      let payload: unknown;
      try { payload = await boundedJson(request.body, TRANSPORT_LIMITS.requestBytes, controller.signal); }
      catch (error) { if (error instanceof RelayFailure) throw error; throw new RelayFailure('request'); }
      if (!isRecord(payload) || typeof payload.stream !== 'boolean' || (payload.max_tokens!==undefined&&payload.max_completion_tokens!==undefined)) throw new RelayFailure('request');
      try {
        body = createCompletionBody({ freeOnly:request.headers.get('X-Hikmah-Free-Only')==='true'||(isRecord(payload.provider)&&isRecord(payload.provider.max_price)&&payload.provider.max_price.prompt===0&&payload.provider.max_price.completion===0&&payload.provider.max_price.request===0), baseUrl: provider.baseUrl, apiKey: key,
          model: payload.model as string, maxTokens: (payload.max_tokens??payload.max_completion_tokens) as number, temperature: (payload.temperature??0.3) as number,
          reasoningEffort:(payload.reasoning_effort ?? (isRecord(payload.reasoning) ? payload.reasoning.effort : undefined)) as 'default' | undefined,customSampling:payload.temperature!==undefined,stream:payload.stream,tokenParameter:payload.max_completion_tokens!==undefined?'max_completion_tokens':'max_tokens',
        }, payload.messages as ChatMessage[], payload.tools as ToolDefinition[] | undefined);
      } catch { throw new RelayFailure('request'); }
    }
    if (controller.signal.aborted) throw new RelayFailure('timeout');
    const upstream = await abortable(fetch(`${provider.baseUrl}/${operation === 'chat' ? 'chat/completions' : 'models'}`, {
      method: body ? 'POST' : 'GET', body,
      headers: { Authorization: `Bearer ${key}`, Accept: body ? 'text/event-stream, application/json' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
    }), controller.signal);
    if (!upstream.ok || upstream.redirected) {
      if (upstream.status >= 400 && upstream.status <= 599) {
        let data:unknown;try{data=await boundedJson(upstream.body,65536,controller.signal);}catch{/* Error prose is never forwarded. */}
        const diagnostic=diagnoseProviderError(data,upstream.status);
        const retry=Number(upstream.headers.get('Retry-After'));
        return Response.json({error:{code:diagnostic.code,param:diagnostic.parameter}}, {status:upstream.status,headers:{...privateHeaders,...(retry>0&&retry<=86400?{'Retry-After':String(Math.ceil(retry))}:{})}});
      }
      void upstream.body?.cancel().catch(() => {});
      throw new RelayFailure('protocol');
    }
    const type = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    const limit = operation === 'models' ? TRANSPORT_LIMITS.responseBytes : Number.POSITIVE_INFINITY;
    if (Number(upstream.headers.get('content-length')) > limit) { void upstream.body?.cancel().catch(() => {}); throw new RelayFailure('limit'); }
    if (operation === 'models') {
      let data: unknown;
      try { data = await boundedJson(upstream.body, limit, controller.signal); }
      catch (error) { if (error instanceof RelayFailure) throw error; throw new RelayFailure('protocol'); }
      if (!isRecord(data) || data.error || !Array.isArray(data.data)) throw new RelayFailure('protocol');
      // Do not forward unused catalog metadata. This also keeps growing catalogs
      // independent of streaming generation limits.
      let models = data.data.map(normalizeModel).filter((m): m is NonNullable<typeof m> => m !== null);
      if (provider.id === 'experiential') {
        const metadataController = new AbortController();
        const stopMetadata = () => metadataController.abort();
        controller.signal.addEventListener('abort', stopMetadata, { once: true });
        const metadataTimeout = setTimeout(stopMetadata, 20000);
        try {
          const metadata = await fetch('https://api.experientiallabs.ai/api/models?limit=1000', { signal: metadataController.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (metadata.ok) models = enrichExperientialModels(models, await boundedJson(metadata.body, 4_000_000, metadataController.signal));
          else void metadata.body?.cancel().catch(() => {});
        } catch { /* Account catalog remains usable when public metadata is unavailable. */ }
        finally { clearTimeout(metadataTimeout); controller.signal.removeEventListener('abort', stopMetadata); metadataController.abort(); }
      }
      const output = JSON.stringify({ data: models });
      if (new TextEncoder().encode(output).byteLength > TRANSPORT_LIMITS.responseBytes) throw new RelayFailure('limit');
      return new Response(output, { headers: { ...privateHeaders, 'Content-Type': 'application/json' } });
    }
    if (!upstream.body || type.includes('text/html')) {
      if(upstream.body)void upstream.body.cancel().catch(()=>{});
      throw new RelayFailure('protocol');
    }
    const reader = upstream.body.getReader();

    const responseBody = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const { done, value } = await abortable(reader.read(), controller.signal);
          if (done) { cleanup(); output.close(); return; }
          if(value.byteLength)touch();
          output.enqueue(value);
        } catch (error) {
          const code = error instanceof RelayFailure ? error.code : controller.signal.aborted ? 'timeout' : 'network';
          cleanup();
          void reader.cancel().catch(() => {});
          if (type.includes('text/event-stream') && !request.signal.aborted) {
            output.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify({ error: { code: `relay_${code}` } })}\n\n`));
            output.close();
          } else output.error(new Error(RELAY_ERRORS[code].message));
        }
      },
      cancel() { cleanup(); void reader.cancel().catch(() => {}); },
    });
    streaming = true;
    return new Response(responseBody, { headers: { ...privateHeaders, ...(type ? { 'Content-Type': type } : {}), 'X-Accel-Buffering': 'no' } });
  } catch (error) {
    return relayFailure(error instanceof RelayFailure ? error.code : controller.signal.aborted ? 'timeout' : 'network');
  } finally { if (!streaming) cleanup(); }
}
