// Generating media as a run tool. The properties that matter are what the model
// is handed back, what is stored, and what happens when a provider misbehaves.
// Run: node --test tests/media-tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaAssets, isStorableMedia } from '../lib/server/media-assets.ts';
import { parseImageResponse } from '../lib/server/media-core.ts';
import { mediaTools } from '../lib/ai/tools/media.ts';

/** The object bucket, in memory. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { bytes: async () => value };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// --- Storage ---------------------------------------------------------------

test('an asset is stored under its owner, so an id alone reaches nothing', async () => {
  // The id travels in a transcript the owner may paste somewhere. It is not the
  // thing that authorises the read.
  const store = bucket();
  const assets = createMediaAssets(store);
  const id = await assets.put('user-1', png, 'image/png');

  assert.deepEqual((await assets.get('user-1', id)).bytes, png);
  assert.equal(await assets.get('user-2', id), null);
});

test('the media type survives the round trip', async () => {
  const assets = createMediaAssets(bucket());
  const mp3 = await assets.put('user-1', png, 'audio/mpeg');
  assert.equal((await assets.get('user-1', mp3)).mime, 'audio/mpeg');
  const webp = await assets.put('user-1', png, 'image/webp');
  assert.equal((await assets.get('user-1', webp)).mime, 'image/webp');
});

test('an unsupported type is refused rather than stored under a default', async () => {
  // A file served as the wrong type is a file the browser interprets as
  // something else, so guessing here is the one thing not to do.
  const assets = createMediaAssets(bucket());
  await assert.rejects(assets.put('user-1', png, 'text/html'), /Unsupported media type/);
  await assert.rejects(assets.put('user-1', png, 'image/svg+xml'), /Unsupported media type/);
  assert.equal(isStorableMedia('image/svg+xml'), false);
  assert.equal(isStorableMedia('image/png'), true);
});

test('a malformed id reads as absent rather than reaching the bucket', async () => {
  const store = bucket();
  const assets = createMediaAssets(store);
  for (const id of ['../../etc/passwd', 'x.png', '', 'a'.repeat(36) + '.exe'])
    assert.equal(await assets.get('user-1', id), null, id);
  assert.equal(store.objects.size, 0);
});

// --- Provider responses ----------------------------------------------------

test('an image type the provider invents is replaced, not trusted', () => {
  // The type decides how the bytes are interpreted when they are rendered.
  const parsed = parseImageResponse({
    data: [
      { b64_json: 'AAA', media_type: 'text/html' },
      { b64_json: 'BBB', media_type: 'image/webp' },
    ],
  });
  assert.deepEqual(
    parsed.map((image) => image.mime),
    ['image/png', 'image/webp'],
  );
});

test('a response with no usable image yields nothing rather than a placeholder', () => {
  assert.deepEqual(parseImageResponse({ data: [{ url: 'https://example.test/x.png' }] }), []);
  assert.deepEqual(parseImageResponse({}), []);
  assert.deepEqual(parseImageResponse(null), []);
});

// --- The tools -------------------------------------------------------------

/** The tools, with the provider replaced by a scripted fetch. */
function tools(fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const assets = createMediaAssets(bucket());
  return {
    tools: mediaTools({
      userId: 'user-1',
      assets,
      key: 'k',
      signal: new AbortController().signal,
    }),
    assets,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('a generated image reaches the model as a reference, never as bytes', async (t) => {
  // Twenty megabytes of base64 in a transcript would cost more context than the
  // whole conversation and tell the model nothing it can reason about.
  const context = tools(async () =>
    jsonResponse({
      data: [{ b64_json: Buffer.from(png).toString('base64'), media_type: 'image/png' }],
    }),
  );
  t.after(context.restore);

  const output = await context.tools.generate_image.execute({ prompt: 'a minaret at dawn' });
  assert.equal(output.images.length, 1);
  assert.match(output.images[0].url, /^\/api\/media\/assets\/[0-9a-f-]{36}\.png$/);
  assert.equal(output.images[0].prompt, 'a minaret at dawn');
  assert.equal(JSON.stringify(output).includes('b64'), false, 'no bytes in the transcript');

  const id = output.images[0].url.split('/').pop();
  assert.deepEqual((await context.assets.get('user-1', id)).bytes, png, 'and it was stored');
});

test('a provider failure is returned to the model, not thrown at the run', async (t) => {
  // A failed picture is something to tell the person about and often work
  // around. Ending the run over it loses the rest of the answer too.
  const context = tools(
    async () =>
      new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 }),
  );
  t.after(context.restore);

  const output = await context.tools.generate_image.execute({ prompt: 'anything' });
  assert.ok(output.error, 'reported as a value');
  assert.ok(!output.images);
});

test('audio answered as JSON is refused rather than shown as a silent player', async (t) => {
  // A provider replying to a speech request with JSON is reporting something,
  // not speaking.
  const context = tools(async () => jsonResponse({ error: 'no voice' }));
  t.after(context.restore);

  const output = await context.tools.generate_speech.execute({ text: 'as-salamu alaykum' });
  assert.match(output.error, /did not return playable audio/);
});

test('generated speech is stored and referenced like an image', async (t) => {
  const context = tools(
    async () => new Response(png, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
  );
  t.after(context.restore);

  const output = await context.tools.generate_speech.execute({ text: 'bismillah' });
  assert.equal(output.audio.kind, 'audio');
  assert.match(output.audio.url, /\.mp3$/);
  assert.equal(output.audio.prompt, 'bismillah');
});
