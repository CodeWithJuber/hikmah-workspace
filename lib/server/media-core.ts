/** Calling OpenRouter's media endpoints from the server.
 *
 * `media-relay.ts` already speaks to these endpoints, but it is a
 * Request-to-Response adapter for the browser: it checks Origin, reads the
 * provider key out of request headers, and answers audio by piping a streaming
 * body straight back. A run tool has no request to check and needs the bytes in
 * hand so it can store them and hand the model back a reference. So the call
 * itself lives here, and the one piece that must never drift between the two —
 * which image types are accepted out of a provider response — is shared rather
 * than written twice.
 */
import { diagnoseProviderError } from '../playground/provider-diagnostics.ts';

export const MEDIA_BASE = 'https://openrouter.ai/api/v1';

/** Image types this workspace will serve back to a browser. Anything else a
 * provider claims is replaced rather than trusted: the type decides how the
 * bytes are interpreted when they are rendered. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Longer than a slow image, shorter than a hung connection. */
const TIMEOUT_MS = 300_000;

export type MediaFailure = { ok: false; message: string; code: string; status: number };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Read a body with a ceiling, so a hostile or broken provider cannot fill the
 * container's memory. */
async function bounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new Error('empty');
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('limit');
      parts.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The images in a provider's response, with their types checked.
 *
 * Shared with the relay: a media type the browser will act on is not something
 * to take from a provider unexamined, and having that allowlist in two places
 * would mean fixing it in one.
 */
export function parseImageResponse(data: unknown): { b64: string; mime: string }[] {
  if (!object(data) || !Array.isArray(data.data)) return [];
  return data.data
    .filter(object)
    .filter((entry) => typeof entry.b64_json === 'string' && entry.b64_json.length < 23_000_000)
    .slice(0, 4)
    .map((entry) => ({
      b64: entry.b64_json as string,
      mime: IMAGE_TYPES.includes(String(entry.media_type))
        ? (entry.media_type as string)
        : 'image/png',
    }));
}

type CallOptions = {
  path: string;
  payload: Record<string, unknown>;
  key: string;
  signal?: AbortSignal;
  /** How much of the answer to accept. */
  limit: number;
  accept: string;
};

type CallResult = MediaFailure | { ok: true; bytes: Uint8Array; mime: string };

/** One request to a media endpoint, with a timeout and the provider's own error
 * wording where it gives one. */
async function callProvider(options: CallOptions): Promise<CallResult> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, TIMEOUT_MS);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();

  try {
    const response = await fetch(MEDIA_BASE + options.path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + options.key,
        Accept: options.accept,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    });

    if (!response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(await bounded(response.body, 65536)));
      } catch {
        /* a provider that cannot even answer in JSON is diagnosed by status */
      }
      const diagnosis = diagnoseProviderError(data, response.status);
      return {
        ok: false,
        message: diagnosis.message + ' ' + diagnosis.action,
        code: diagnosis.code,
        status: response.status >= 400 && response.status <= 599 ? response.status : 502,
      };
    }

    return {
      ok: true,
      bytes: await bounded(response.body, options.limit),
      mime: response.headers.get('content-type')?.split(';')[0].trim() ?? '',
    };
  } catch {
    return {
      ok: false,
      message: controller.signal.aborted
        ? 'The media request stopped or timed out.'
        : 'The media provider could not complete this request.',
      code: 'media_network',
      status: 502,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    controller.abort();
  }
}

export type GeneratedImage = { bytes: Uint8Array; mime: string };

/** Generate one or more images. */
export async function generateImages(options: {
  model: string;
  prompt: string;
  key: string;
  signal?: AbortSignal;
}): Promise<MediaFailure | { ok: true; images: GeneratedImage[] }> {
  const result = await callProvider({
    path: '/images',
    payload: { model: options.model, prompt: options.prompt },
    key: options.key,
    signal: options.signal,
    limit: 24_000_000,
    accept: 'application/json',
  });
  if (!result.ok) return result;

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(result.bytes));
  } catch {
    return {
      ok: false,
      message: 'The image response could not be read.',
      code: 'media_protocol',
      status: 502,
    };
  }
  const images = parseImageResponse(data).map((image) => ({
    bytes: Uint8Array.from(Buffer.from(image.b64, 'base64')),
    mime: image.mime,
  }));
  if (!images.length)
    return {
      ok: false,
      message: 'This image response did not contain a supported image file.',
      code: 'media_protocol',
      status: 502,
    };
  return { ok: true, images };
}

/** Read a passage aloud. */
export async function generateSpeech(options: {
  model: string;
  text: string;
  voice: string;
  key: string;
  signal?: AbortSignal;
}): Promise<MediaFailure | { ok: true; bytes: Uint8Array; mime: string }> {
  const result = await callProvider({
    path: '/audio/speech',
    payload: {
      model: options.model,
      input: options.text,
      voice: options.voice,
      response_format: 'mp3',
    },
    key: options.key,
    signal: options.signal,
    limit: 24_000_000,
    accept: 'audio/mpeg',
  });
  if (!result.ok) return result;
  // A provider answering an audio request with JSON is reporting something, not
  // speaking: rendering it as audio would give the owner a player that plays
  // nothing and no reason why.
  if (!result.mime.startsWith('audio/'))
    return {
      ok: false,
      message: 'The provider did not return playable audio.',
      code: 'media_protocol',
      status: 502,
    };
  return { ok: true, bytes: result.bytes, mime: result.mime };
}
