/** Where generated images and speech live.
 *
 * The old surface kept them in the browser's IndexedDB, which was the only
 * option while the run belonged to the tab. A run belongs to the server now, so
 * the asset has to as well — otherwise reopening a conversation would show a
 * transcript full of media that only the tab that generated it could see.
 *
 * Stored in the object bucket rather than as a database row: these are up to
 * twenty megabytes each, and SQLite's page cache is doing more useful work than
 * holding a picture.
 */
import { randomUUID } from 'node:crypto';
import { IMAGE_TYPES } from './media-core.ts';

/** What may be stored and served, and the extension each is kept under. The
 * extension is what the type is recovered from, so the two are one table and a
 * type outside it is never written. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
};

/** Recovering the type from the extension, so nothing else has to be stored. */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** An asset id: a uuid and an extension, and nothing an owner could guess. */
const ID = /^[0-9a-f-]{36}\.(png|jpg|webp|gif|mp3|wav)$/;

export type Bucket = {
  put(key: string, body: Uint8Array | string): Promise<void>;
  get(key: string): Promise<{ bytes(): Promise<Uint8Array> } | null>;
  delete(key: string): Promise<void>;
};

/** The owner is part of the key, so one owner's assets cannot be read by
 * naming them from another's session even if the id leaks. */
const keyFor = (userId: string, id: string) => `media/${encodeURIComponent(userId)}/${id}`;

export function createMediaAssets(bucket: Bucket) {
  return {
    /** Store one generated asset and return the id it is served under. */
    async put(userId: string, bytes: Uint8Array, mime: string): Promise<string> {
      const extension = EXTENSIONS[mime];
      // Refused rather than stored under a default: a file served with the
      // wrong type is a file the browser will interpret as something else.
      if (!extension) throw new Error('Unsupported media type: ' + mime);
      const id = `${randomUUID()}.${extension}`;
      await bucket.put(keyFor(userId, id), bytes);
      return id;
    },

    /** Read one back, or null when this owner has no such asset. */
    async get(userId: string, id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
      if (!ID.test(id)) return null;
      const object = await bucket.get(keyFor(userId, id));
      if (!object) return null;
      return { bytes: await object.bytes(), mime: TYPES[id.split('.').pop() as string] };
    },
  };
}

export type MediaAssets = ReturnType<typeof createMediaAssets>;

/** Whether this is something the workspace will store and serve. */
export const isStorableMedia = (mime: string) => mime in EXTENSIONS;

/** Images, for a caller that needs to tell them from audio. */
export const isImage = (mime: string) => IMAGE_TYPES.includes(mime);
