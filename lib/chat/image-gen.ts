/** Pure helpers for the chat `/image` command (Chat v2, WS4).
 *
 * Everything in here is dependency-free on purpose: the route calls the
 * provider through `buildImageRequest` + `fetchFirstImage`, and the test
 * suite bundles this file alone with esbuild and mocks `fetch`.
 *
 * Provider reality, read before "fixing" the endpoint: this deployment does
 * NOT call each chat provider's own `/images/generations` endpoint. Image
 * generation always goes through OpenRouter's `POST {base}/images` with a
 * `{model, prompt}` body and `data[].b64_json` answers — see
 * `lib/server/media-core.ts` (`MEDIA_BASE`, `generateImages`), which is the
 * exact call the agent's `generate_image` tool makes. This module describes
 * and performs that same call; it deliberately does not invent a second,
 * per-provider OpenAI-style path.
 */

/** The images endpoint this deployment calls. Mirrors `MEDIA_BASE` in
 * `lib/server/media-core.ts`; kept as a literal here so this module stays
 * import-free for tests. */
export const IMAGE_API_BASE = 'https://openrouter.ai/api/v1';

/** The model used when `HIKMAH_IMAGE_MODEL` is unset. Mirrors
 * `DEFAULT_IMAGE_MODEL` in `lib/ai/tools/media.ts`. */
export const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-1';

/** Image types the chat will render. Mirrors `IMAGE_TYPES` in
 * `lib/server/media-core.ts`; anything else a provider claims is served as
 * PNG rather than trusted. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Largest decoded image the route will store. The run tools allow 24MB
 * (`lib/server/media-core.ts`); a message row is rendered on every
 * conversation open, so this surface is stricter. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Slower than a normal generation, shorter than a hung connection. Mirrors
 * `TIMEOUT_MS` in `lib/server/media-core.ts`. */
export const IMAGE_TIMEOUT_MS = 300_000;

/**
 * The prompt of a `/image` or `/imagine` command, or null when the text is
 * not one. Case-insensitive, trims the prompt, and returns null for a bare
 * command with no prompt — a command with nothing to draw is not a command.
 */
export function parseImageCommand(text: string): string | null {
  const match = /^\s*\/(image|imagine)\b\s*([\s\S]*)$/i.exec(text);
  if (!match) return null;
  const prompt = match[2].trim();
  return prompt ? prompt : null;
}

export type ImageRequestOptions = {
  /** Image model id. Defaults to `DEFAULT_IMAGE_MODEL`; the route passes
   * `process.env.HIKMAH_IMAGE_MODEL`, exactly like the agent tool context. */
  model?: string;
  /** The media key from `mediaKeyFor` — an OpenRouter-usable key in both of
   * its branches. Never logged; it travels only in the Authorization header. */
  apiKey: string;
  /** Override for tests. Production always uses `IMAGE_API_BASE`. */
  baseUrl?: string;
};

export type ImageRequestDescriptor = {
  url: string;
  body: { model: string; prompt: string };
  headers: Record<string, string>;
};

/**
 * The `POST {base}/images` request for a prompt — same shape the agent's
 * `generate_image` tool sends. The key appears in exactly one place, the
 * `Authorization` header; the returned descriptor is safe to inspect in tests
 * but must never be logged in production.
 */
export function buildImageRequest(
  prompt: string,
  options: ImageRequestOptions,
): ImageRequestDescriptor {
  const base = (options.baseUrl ?? IMAGE_API_BASE).replace(/\/+$/, '');
  return {
    url: base + '/images',
    body: { model: options.model || DEFAULT_IMAGE_MODEL, prompt },
    headers: {
      Authorization: 'Bearer ' + options.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  };
}

/** Thrown when image generation is not available; the route turns it into a 403. */
export class ImageNotAllowedError extends Error {
  readonly status = 403;
  constructor(message = 'Image generation is not available on your plan.') {
    super(message);
    this.name = 'ImageNotAllowedError';
  }
}

/** Guard the route calls after deriving the media key. */
export function assertImageAllowed(mediaKey: string): asserts mediaKey is string {
  if (!mediaKey) throw new ImageNotAllowedError();
}

/** Thrown for provider failures. The message is safe to show the owner: it
 * never carries the key, the prompt, or the provider's raw body. */
export class ImageProviderError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = 'ImageProviderError';
    this.status = options?.status ?? 502;
    this.code = options?.code ?? 'image_provider';
  }
}

export type FetchedImage =
  | { kind: 'bytes'; bytes: Uint8Array; mediaType: string }
  | { kind: 'url'; url: string; mediaType: string };

const asObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The media type to serve, from the allowlist — never the provider's word. */
function safeMediaType(claimed: unknown): string {
  return typeof claimed === 'string' && IMAGE_TYPES.includes(claimed) ? claimed : 'image/png';
}

/** Read a body with a ceiling, so a hostile or broken provider cannot fill
 * the container's memory. Same shape as `bounded` in media-core. */
async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new ImageProviderError('The image response was empty.', { code: 'image_empty' });
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new ImageProviderError('The image response was too large.', {
          code: 'image_too_large',
        });
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

function decodeBase64(b64: string): Uint8Array {
  // Buffer is available in the route (Node) and in the node:test bundle.
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Perform one images request and return the first image. `b64_json` answers
 * come back as bytes (size-checked against `MAX_IMAGE_BYTES`); a `url`
 * answer is kept as a URL and never downloaded. `fetchImpl` exists so tests
 * can mock the network; production passes the global fetch.
 */
export async function fetchFirstImage(
  request: ImageRequestDescriptor,
  options?: {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<FetchedImage> {
  const runFetch = options?.fetchImpl ?? fetch;
  const maxBytes = options?.maxBytes ?? MAX_IMAGE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? IMAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await runFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ImageProviderError(
      controller.signal.aborted
        ? 'The image request timed out.'
        : 'The image provider could not be reached.',
      { code: 'image_network', status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new ImageProviderError(
        'The image provider rejected the request. Check the media key in Settings → Connection.',
        { status: 502, code: 'image_auth' },
      );
    if (response.status === 429)
      throw new ImageProviderError('The image provider is rate-limited. Try again shortly.', {
        status: 502,
        code: 'image_rate_limited',
      });
    throw new ImageProviderError('Image generation failed. Try again shortly.', {
      status: 502,
      code: 'image_failed',
    });
  }

  // The JSON envelope carries the base64, so the body ceiling has to allow
  // base64 overhead (~4/3) over the byte limit.
  const raw = await boundedBody(response.body, Math.ceil(maxBytes * 1.5) + 65536);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ImageProviderError('The image response could not be read.', {
      code: 'image_protocol',
    });
  }
  const first = asObject(data) && Array.isArray(data.data) ? data.data[0] : undefined;
  if (!asObject(first))
    throw new ImageProviderError('The image response contained no image.', {
      code: 'image_protocol',
    });

  if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    const bytes = decodeBase64(first.b64_json);
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
      throw new ImageProviderError('The generated image was too large.', {
        code: 'image_too_large',
      });
    return { kind: 'bytes', bytes, mediaType: safeMediaType(first.media_type) };
  }
  if (typeof first.url === 'string' && first.url.length > 0)
    return { kind: 'url', url: first.url, mediaType: safeMediaType(first.media_type) };
  throw new ImageProviderError('The image response contained no image.', {
    code: 'image_protocol',
  });
}

/**
 * The message parts for a generated image, in the shape
 * `saveAssistantMessage` stores: a text part carrying the prompt (the
 * transcript-readable record of what was asked for) and a `file` part the
 * chat renders as the picture. The URL is an `/api/media/assets/...` URL the
 * route stored, or the provider's own URL — never a data URL, so message
 * rows stay small.
 */
export function toImageParts(
  url: string,
  mediaType: string,
  prompt: string,
  filename?: string,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
    { type: 'file', mediaType, url },
  ];
  if (filename) (parts[1] as Record<string, unknown>).filename = filename;
  return parts;
}
