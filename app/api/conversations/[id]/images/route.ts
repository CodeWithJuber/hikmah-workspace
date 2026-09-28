import { randomUUID } from 'node:crypto';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';
import { mediaKeyFor } from '@/lib/runs/media';
import { executionRunConfig } from '@/server/run-credentials.mjs';
import { createMediaAssets } from '@/lib/server/media-assets';
import { getStorage } from '@/server/storage.mjs';
import {
  parseImageCommand,
  buildImageRequest,
  fetchFirstImage,
  assertImageAllowed,
  toImageParts,
  ImageNotAllowedError,
  ImageProviderError,
} from '@/lib/chat/image-gen';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Slash-command prompts are capped: a caption-length ask, not a novel. */
const MAX_PROMPT_CHARS = 4000;

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * The media key for an explicit `/image` request, derived exactly the way the
 * worker derives it for the agent's `generate_image` tool.
 *
 * The worker calls `mediaKeyFor(config)` where `config` is the decrypted run
 * config (`driveWithAgent` in `lib/runs/service.ts`). This route passes the
 * same three fields — `{media, baseUrl, apiKey}` — from the conversation's
 * newest run row via `executionRunConfig`, which decrypts the sealed
 * credential snapshot the same way execution does. So a BYOK OpenRouter user
 * with no `HIKMAH_MEDIA_KEY` gets their own key here, exactly as the tool
 * would, and a plan without media gets '' and a 403.
 *
 * Fallbacks, in order: no runs yet for this conversation, or a run row that
 * will not decrypt (legacy rows throw) → `{baseUrl: '', apiKey: ''}`, which
 * makes `mediaKeyFor` answer from `HIKMAH_MEDIA_KEY` alone. The raw key is
 * never logged and never leaves this request.
 */
function mediaKeyForConversation(conversationId: string): string {
  try {
    const row = getStorage()
      .raw.prepare(
        `SELECT id, user_id, config FROM runs
         WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(conversationId) as { id: string; user_id?: string; config: string } | undefined;
    if (row?.config) {
      const config = executionRunConfig(row) as {
        media?: boolean;
        baseUrl: string;
        apiKey: string;
      };
      return mediaKeyFor(
        { media: config.media, baseUrl: config.baseUrl, apiKey: config.apiKey },
        process.env,
      );
    }
  } catch {
    // A row that will not decrypt is not a reason to refuse outright; the
    // env-only derivation below still applies.
  }
  return mediaKeyFor({ baseUrl: '', apiKey: '' }, process.env);
}

/**
 * Generate an image from a `/image` / `/imagine` command and store it as an
 * assistant message on the conversation.
 *
 * The provider call is the same OpenRouter `POST /images` the agent's
 * `generate_image` tool makes (`lib/server/media-core.ts`), but through the
 * bounded client in `lib/chat/image-gen.ts` (8MB ceiling). Bytes are stored
 * in the owner-scoped media bucket — the message part carries the
 * `/api/media/assets/...` URL, never a data URL, so message rows stay small.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  const worker = runService();
  const existing = worker.store.getConversation(id);
  // Not this owner's, or not there at all: the same answer to both, so the
  // reply cannot be used to find out which. A missing conversation is created
  // here, the same as the runs route does — an /image command can be the
  // first message of a fresh /chat/<id>, which has no rows yet.
  if (existing && existing.user_id !== user.userId) return fail('Conversation not found.', 404);
  if (!existing)
    try {
      worker.store.createConversation({ id, userId: user.userId, model: '' });
    } catch {
      /* already created by a concurrent request */
    }

  let raw: string;
  let userText: string;
  try {
    const body = (await request.json()) as { prompt?: unknown; text?: unknown; userText?: unknown };
    const candidate = typeof body.prompt === 'string' ? body.prompt : body.text;
    raw = typeof candidate === 'string' ? candidate : '';
    // The full composer text ("/image a red cat"), stored as the user turn
    // so the transcript shows what was asked, not just the picture.
    userText = typeof body.userText === 'string' ? body.userText : '';
  } catch {
    return fail('Send a JSON body with a prompt.', 400);
  }
  // Accept the raw composer text as a courtesy: `/image a red cat` works as
  // well as a bare prompt.
  const prompt = (parseImageCommand(raw) ?? raw.trim()).slice(0, MAX_PROMPT_CHARS).trim();
  if (!prompt) return fail('Describe the image to generate.', 400);

  let mediaKey: string;
  try {
    mediaKey = mediaKeyForConversation(id);
    assertImageAllowed(mediaKey);
  } catch (error) {
    if (error instanceof ImageNotAllowedError) return fail(error.message, error.status);
    return fail('Image generation is not available on your plan.', 403);
  }

  let image:
    | { kind: 'bytes'; bytes: Uint8Array; mediaType: string }
    | { kind: 'url'; url: string; mediaType: string };
  try {
    image = await fetchFirstImage(
      buildImageRequest(prompt, {
        model: process.env.HIKMAH_IMAGE_MODEL,
        apiKey: mediaKey,
      }),
    );
  } catch (error) {
    if (error instanceof ImageProviderError) {
      console.error('[images] provider error', error.code);
      return fail(error.message, error.status);
    }
    console.error('[images] unexpected error');
    return fail('Image generation failed. Try again shortly.', 500);
  }

  // Bytes go to the owner-scoped bucket (same as the agent's generate_image
  // tool); a provider URL is kept as-is and never downloaded.
  let url: string;
  let filename: string | undefined;
  if (image.kind === 'bytes') {
    const assets = createMediaAssets(getStorage().BUCKET);
    let assetId: string;
    try {
      assetId = await assets.put(user.userId, image.bytes, image.mediaType);
    } catch {
      return fail('The generated image was not a supported type.', 502);
    }
    url = `/api/media/assets/${assetId}`;
    filename = `generated-image.${EXTENSION[image.mediaType] ?? 'png'}`;
  } else {
    url = image.url;
  }

  const model = process.env.HIKMAH_IMAGE_MODEL || 'openai/gpt-image-1';
  // The user's command is a real turn in the tree: it answers whatever the
  // active path ends at, and the image answers it — so branching, forking
  // and the transcript all treat an /image turn like any other.
  let userMessage: { id: string; role: string; parts: unknown[]; metadata: unknown } | undefined;
  const trimmedUserText = userText.trim().slice(0, MAX_PROMPT_CHARS);
  if (trimmedUserText) {
    userMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: trimmedUserText }],
      metadata: undefined,
    };
    worker.store.appendMessage(id, userMessage, worker.store.lastActiveMessageId(id));
  }
  const message = {
    id: randomUUID(),
    role: 'assistant',
    parts: toImageParts(url, image.mediaType, prompt, filename),
    metadata: { image: true, model, prompt },
  };
  worker.store.saveAssistantMessage(
    id,
    message,
    userMessage?.id ?? worker.store.lastActiveMessageId(id),
  );
  return Response.json({ message, userMessage: userMessage ?? null }, { headers });
}
