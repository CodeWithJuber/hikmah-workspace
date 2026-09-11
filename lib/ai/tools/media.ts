/** Generating images and speech, as run tools.
 *
 * The old surface generated media from a button in the composer and kept the
 * result in the browser. Making it a tool changes two things that matter: the
 * model can decide a picture is the answer without the owner having to know in
 * advance, and the result is stored where a reopened conversation can still
 * find it.
 *
 * What the model gets back is a reference and a description, never the bytes.
 * Twenty megabytes of base64 in a transcript would cost more context than the
 * whole conversation and tell the model nothing it can reason about.
 *
 * Video and transcription are deliberately absent. Video generation is an
 * asynchronous job that has to be polled across steps, and transcription needs
 * a file the owner uploads; both are their own piece of work rather than a
 * variation on these.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { generateImages, generateSpeech } from '../../server/media-core.ts';
import type { MediaAssets } from '../../server/media-assets.ts';

export type MediaToolContext = {
  /** Whose assets these are. */
  userId: string;
  /** Storage for what comes back. */
  assets: MediaAssets;
  /** The OpenRouter key, resolved once when the run was queued. Absent means
   * media is not configured, and the tools are not offered at all. */
  key: string;
  /** Defaults when the model names no model of its own. */
  imageModel?: string;
  speechModel?: string;
  speechVoice?: string;
  signal: AbortSignal;
};

/** Sensible defaults so the tool works without the owner configuring a model
 * first. Overridable per call, because a model that knows a better one should
 * be able to say so. */
const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-1';
const DEFAULT_SPEECH_MODEL = 'openai/gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';

/** What a generated asset looks like in the transcript. */
export type MediaOutput = {
  kind: 'image' | 'audio';
  /** Where the browser fetches it. Owner-scoped: the route serves only assets
   * belonging to the session asking. */
  url: string;
  mediaType: string;
  bytes: number;
  /** Repeated back so the transcript says what was asked for, which is the part
   * the model can actually reason about later. */
  prompt: string;
};

export function mediaTools(context: MediaToolContext) {
  const store = async (
    bytes: Uint8Array,
    mime: string,
    kind: 'image' | 'audio',
    prompt: string,
  ): Promise<MediaOutput> => {
    const id = await context.assets.put(context.userId, bytes, mime);
    return {
      kind,
      url: `/api/media/assets/${id}`,
      mediaType: mime,
      bytes: bytes.byteLength,
      prompt,
    };
  };

  return {
    generate_image: tool({
      description:
        'Generate an image from a description. Use when a picture, diagram, illustration or visual mock-up is what was asked for, or is clearly the most useful answer. The image is shown to the person; you receive only a reference to it, so describe what you made in your reply.',
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(12000)
          .describe('What to draw, in detail. Subject, style, composition, colours.'),
        model: z
          .string()
          .max(256)
          .optional()
          .describe('An image model id, if a specific one is needed.'),
      }),
      execute: async ({ prompt, model }) => {
        const result = await generateImages({
          model: model || context.imageModel || DEFAULT_IMAGE_MODEL,
          prompt,
          key: context.key,
          signal: context.signal,
        });
        // Returned as a value rather than thrown: a failed picture is something
        // the model should tell the person about and can often retry or work
        // around, not a reason to end the run.
        if (!result.ok) return { error: result.message, code: result.code };
        const images = [];
        for (const image of result.images)
          images.push(await store(image.bytes, image.mime, 'image', prompt));
        return { images };
      },
    }),

    generate_speech: tool({
      description:
        'Read a passage aloud and attach the audio. Use when speech is what was asked for — a recitation, a pronunciation, something to listen to. The person gets a player; you receive only a reference.',
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(12000)
          .describe('The words to speak, exactly as they should be read.'),
        voice: z.string().max(100).optional(),
        model: z.string().max(256).optional(),
      }),
      execute: async ({ text, voice, model }) => {
        const result = await generateSpeech({
          model: model || context.speechModel || DEFAULT_SPEECH_MODEL,
          text,
          voice: voice || context.speechVoice || DEFAULT_VOICE,
          key: context.key,
          signal: context.signal,
        });
        if (!result.ok) return { error: result.message, code: result.code };
        return { audio: await store(result.bytes, result.mime, 'audio', text) };
      },
    }),
  };
}
