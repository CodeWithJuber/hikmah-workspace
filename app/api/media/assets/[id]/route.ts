import { getChatGPTUser } from '../../../../chatgpt-auth';
import { createMediaAssets } from '@/lib/server/media-assets';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

/**
 * Serve one generated image or audio file back to its owner.
 *
 * The owner is part of the storage key, so this cannot return another owner's
 * asset even if an id is guessed or copied out of a shared transcript.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return new Response('Sign in to your private workspace.', { status: 401 });

  const { id } = await context.params;
  const asset = await createMediaAssets(getStorage().BUCKET).get(user.userId, id);
  if (!asset) return new Response('Not found.', { status: 404 });

  return new Response(asset.bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': asset.mime,
      // The id is a uuid and the bytes never change, so this can be cached hard
      // — but only by the one browser it belongs to.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Nothing here is a document, and a stored file should not be able to act
      // as one if a type ever slips through.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
