import type { SecretResolver } from '../playground/secret-reference.ts';
import { publicOrigin } from './origin.ts';
import { diagnoseProviderError } from '../playground/provider-diagnostics.ts';
import { parseImageResponse } from './media-core.ts';
const BASE = 'https://openrouter.ai/api/v1';
const HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,240}$/.test(v);
function failure(message: string, status = 400, code = 'media_request') {
  return Response.json({ error: { message, code } }, { status, headers: HEADERS });
}
async function bounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw Error('empty');
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw Error('limit');
      parts.push(part.value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export async function relayMediaRequest(
  request: Request,
  authenticated: boolean,
  resolveSecret?: SecretResolver,
): Promise<Response> {
  if (!authenticated) return failure('Sign in to this workspace again.', 401, 'media_session');
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (
    (origin && origin !== publicOrigin(request)) ||
    (site && site !== 'same-origin') ||
    (!origin && site !== 'same-origin')
  )
    return failure('Use this workspace to make the request.', 403, 'media_origin');
  let key = request.headers.get('X-Hikmah-Provider-Key')?.trim() ?? '';
  const reference = request.headers.get('X-Hikmah-Secret-Ref');
  if (reference) {
    try {
      if (!resolveSecret) throw Error();
      key = await resolveSecret(reference, 'provider:openrouter');
    } catch {
      return failure(
        'Saved media secret is missing or assigned to another service. Check Settings → Secrets.',
        401,
        'media_key',
      );
    }
  }
  if (!key || key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key))
    return failure('Add an OpenRouter media key in Workspace admin.', 401, 'media_key');
  const op = url.searchParams.get('operation');
  const kind = url.searchParams.get('kind');
  let path = '';
  let payload: Record<string, unknown> | undefined;
  const isGet = op === 'models' || op === 'video_status' || op === 'video_content';
  if (request.method !== (isGet ? 'GET' : 'POST')) return failure('Unsupported media request.');
  try {
    if (op === 'models') {
      const paths: Record<string, string> = {
        image: '/images/models',
        speech: '/models?output_modalities=speech',
        transcription: '/models?output_modalities=transcription',
        video: '/videos/models',
      };
      path = paths[kind ?? ''];
      if (!path) return failure('Choose a media type.');
    } else if (op === 'video_status' || op === 'video_content') {
      const id = url.searchParams.get('job');
      if (!safeId(id)) return failure('Invalid video job.');
      path =
        '/videos/' + encodeURIComponent(id) + (op === 'video_content' ? '/content?index=0' : '');
    } else {
      if (
        !['image', 'speech', 'transcribe', 'video'].includes(op ?? '') ||
        !request.headers.get('content-type')?.startsWith('application/json')
      )
        return failure('Unsupported media operation.');
      const bytes = await bounded(request.body, 12_000_000);
      const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !object(raw) ||
        typeof raw.model !== 'string' ||
        !raw.model.trim() ||
        raw.model.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(raw.model)
      )
        return failure('Choose a valid media model.');
      payload = { model: raw.model };
      if (op === 'transcribe') {
        if (
          !object(raw.input_audio) ||
          typeof raw.input_audio.data !== 'string' ||
          raw.input_audio.data.length > 11_000_000 ||
          !/^[A-Za-z0-9+/=\r\n]+$/.test(raw.input_audio.data) ||
          !['wav', 'mp3'].includes(String(raw.input_audio.format))
        )
          return failure('Upload a WAV or MP3 file up to 8 MB.');
        payload.input_audio = { data: raw.input_audio.data, format: raw.input_audio.format };
        payload.response_format = 'json';
        path = '/audio/transcriptions';
      } else {
        if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 12000)
          return failure('Enter a prompt up to 12,000 characters.');
        if (op === 'speech') {
          if (typeof raw.voice !== 'string' || !raw.voice.trim() || raw.voice.length > 100)
            return failure('Configure a voice supported by your speech model.');
          payload.input = raw.prompt;
          payload.voice = raw.voice;
          payload.response_format = 'mp3';
          path = '/audio/speech';
        } else {
          payload.prompt = raw.prompt;
          path = op === 'image' ? '/images' : '/videos';
        }
      }
    }
  } catch {
    return failure('The media request is invalid or too large.');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, 300000);
  request.signal.addEventListener('abort', stop, { once: true });
  if (request.signal.aborted) stop();
  let streaming = false;
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', stop);
    controller.abort();
  };
  try {
    const response = await fetch(BASE + path, {
      method: isGet ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json, audio/mpeg, video/mp4',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(await bounded(response.body, 65536)));
      } catch {}
      const d = diagnoseProviderError(data, response.status);
      return failure(
        d.message + ' ' + d.action,
        response.status >= 400 && response.status <= 599 ? response.status : 502,
        d.code,
      );
    }
    if (op === 'speech' || op === 'video_content') {
      const mime = response.headers.get('content-type') ?? '';
      if (
        !(op === 'speech' ? mime.startsWith('audio/') : mime.startsWith('video/')) ||
        !response.body
      )
        return failure('The provider did not return playable media.', 502, 'media_protocol');
      const reader = response.body.getReader();
      let total = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) {
          try {
            const part = await reader.read();
            if (part.done) {
              cleanup();
              out.close();
              return;
            }
            total += part.value.byteLength;
            if (total > 64_000_000) throw Error('Media is too large');
            out.enqueue(part.value);
          } catch {
            cleanup();
            void reader.cancel().catch(() => {});
            out.error(new Error('Media download stopped.'));
          }
        },
        cancel() {
          cleanup();
          void reader.cancel().catch(() => {});
        },
      });
      streaming = true;
      return new Response(stream, { headers: { ...HEADERS, 'Content-Type': mime } });
    }
    const data: unknown = JSON.parse(
      new TextDecoder().decode(
        await bounded(response.body, op === 'image' ? 24_000_000 : 4_000_000),
      ),
    );
    if (!object(data)) return failure('Invalid media response.', 502, 'media_protocol');
    if (op === 'models') {
      if (!Array.isArray(data.data))
        return failure('The provider did not return this media catalog.', 502, 'media_protocol');
      const rows = data.data
        .filter(object)
        .filter((m) => typeof m.id === 'string' && m.id.length <= 256)
        .map((m) => ({
          id: m.id,
          name: typeof m.name === 'string' ? m.name.slice(0, 512) : m.id,
          supported_parameters: m.supported_parameters,
          pricing_skus: m.pricing_skus,
          supported_durations: m.supported_durations,
          supported_resolutions: m.supported_resolutions,
          supported_aspect_ratios: m.supported_aspect_ratios,
        }));
      return Response.json({ data: rows }, { headers: HEADERS });
    }
    if (op === 'image') {
      if (!Array.isArray(data.data))
        return failure('The model returned no images.', 502, 'media_protocol');
      // Shared with the run tool's path: which image types are accepted from a
      // provider decides how a browser will interpret the bytes, so it is one
      // list rather than two that can drift apart.
      const images = parseImageResponse(data).map((image) => ({
        b64_json: image.b64,
        media_type: image.mime,
      }));
      if (!images.length)
        return failure(
          'This image response did not contain a supported image file.',
          502,
          'media_protocol',
        );
      return Response.json({ data: images }, { headers: HEADERS });
    }
    if (op === 'transcribe') {
      if (typeof data.text !== 'string' || data.text.length > 200000)
        return failure('No supported transcript was returned.', 502, 'media_protocol');
      return Response.json({ text: data.text }, { headers: HEADERS });
    }
    const id = data.id ?? url.searchParams.get('job');
    if (!safeId(id))
      return failure('The provider did not return a valid video job ID.', 502, 'media_protocol');
    const status = [
      'pending',
      'in_progress',
      'completed',
      'failed',
      'cancelled',
      'expired',
    ].includes(String(data.status))
      ? String(data.status)
      : 'unknown';
    return Response.json({ id, status }, { status: op === 'video' ? 202 : 200, headers: HEADERS });
  } catch {
    return failure(
      controller.signal.aborted
        ? 'The media request stopped or timed out. Check any saved video job before submitting again.'
        : 'The media provider could not complete this request. No automatic generation retry was made.',
      502,
      'media_network',
    );
  } finally {
    if (!streaming) cleanup();
  }
}
