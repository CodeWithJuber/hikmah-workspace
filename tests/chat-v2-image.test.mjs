import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-image-gen-'));
await build({
  entryPoints: ['lib/chat/image-gen.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const mod = async (n) => import(pathToFileURL(join(dir, n + '.mjs')));
const {
  parseImageCommand,
  buildImageRequest,
  assertImageAllowed,
  toImageParts,
  fetchFirstImage,
  ImageNotAllowedError,
  ImageProviderError,
  DEFAULT_IMAGE_MODEL,
} = await mod('image-gen');

test('parseImageCommand extracts the prompt from /image and /imagine', () => {
  assert.equal(parseImageCommand('/image a red cat'), 'a red cat');
  assert.equal(parseImageCommand('/IMAGINE   sunset over sea  '), 'sunset over sea');
  assert.equal(parseImageCommand('  /image cat'), 'cat');
  assert.equal(parseImageCommand('/Image\nmulti\nline'), 'multi\nline');
});

test('parseImageCommand returns null for non-commands and empty prompts', () => {
  assert.equal(parseImageCommand('hello world'), null);
  assert.equal(parseImageCommand('/image'), null);
  assert.equal(parseImageCommand('/image    '), null);
  assert.equal(parseImageCommand('/imagine'), null);
  assert.equal(parseImageCommand('/images foo'), null);
  assert.equal(parseImageCommand('/imaginex foo'), null);
  assert.equal(parseImageCommand('draw /image a cat'), null);
});

test('buildImageRequest shapes the OpenRouter /images call', () => {
  const req = buildImageRequest('a red cat', { apiKey: 'test-key-123' });
  assert.equal(req.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(req.headers.Authorization, 'Bearer test-key-123');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers.Accept, 'application/json');
  assert.equal(req.body.prompt, 'a red cat');
  assert.equal(req.body.model, DEFAULT_IMAGE_MODEL);
  assert.equal(req.body.model, 'openai/gpt-image-1');
});

test('buildImageRequest passes the model and key through, and honours a baseUrl override', () => {
  const req = buildImageRequest('x', {
    apiKey: 'secret-value',
    model: 'openai/gpt-image-1-mini',
    baseUrl: 'https://proxy.example/v1/',
  });
  assert.equal(req.url, 'https://proxy.example/v1/images');
  assert.equal(req.body.model, 'openai/gpt-image-1-mini');
  // The key travels in exactly one place: the Authorization header.
  assert.equal(req.headers.Authorization, 'Bearer secret-value');
  assert.ok(!JSON.stringify(req.body).includes('secret-value'));
  assert.ok(!req.url.includes('secret-value'));
});

test('assertImageAllowed throws a 403-style error only when the key is missing', () => {
  assert.throws(
    () => assertImageAllowed(''),
    (error) => {
      assert.ok(error instanceof ImageNotAllowedError);
      assert.equal(error.status, 403);
      assert.equal(error.message, 'Image generation is not available on your plan.');
      return true;
    },
  );
  assert.doesNotThrow(() => assertImageAllowed('k'));
});

test('toImageParts produces saveAssistantMessage-compatible parts', () => {
  const parts = toImageParts(
    '/api/media/assets/abc.png',
    'image/png',
    'a red cat',
    'generated-image.png',
  );
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: 'text', text: 'a red cat' });
  assert.deepEqual(parts[1], {
    type: 'file',
    mediaType: 'image/png',
    url: '/api/media/assets/abc.png',
    filename: 'generated-image.png',
  });
  // No filename: the part is still valid, and the whole thing round-trips
  // through the JSON the store writes.
  const bare = toImageParts('https://cdn.example/x.png', 'image/jpeg', 'p');
  assert.deepEqual(bare[1], {
    type: 'file',
    mediaType: 'image/jpeg',
    url: 'https://cdn.example/x.png',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), parts);
});

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const b64 = (s) => Buffer.from(s).toString('base64');

test('fetchFirstImage decodes a b64_json answer into bytes', async () => {
  const seen = {};
  const image = await fetchFirstImage(buildImageRequest('a red cat', { apiKey: 'k' }), {
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.auth = init.headers.Authorization;
      seen.body = JSON.parse(init.body);
      return jsonResponse({ data: [{ b64_json: b64('fake-png-bytes'), media_type: 'image/png' }] });
    },
  });
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(seen.body.model, 'openai/gpt-image-1');
  assert.equal(image.kind, 'bytes');
  assert.equal(image.mediaType, 'image/png');
  assert.equal(Buffer.from(image.bytes).toString(), 'fake-png-bytes');
});

test('fetchFirstImage keeps a url answer as a URL and distrusts the media type', async () => {
  const image = await fetchFirstImage(buildImageRequest('x', { apiKey: 'k' }), {
    fetchImpl: async () =>
      jsonResponse({ data: [{ url: 'https://cdn.example/x.webp', media_type: 'image/bogus' }] }),
  });
  assert.equal(image.kind, 'url');
  assert.equal(image.url, 'https://cdn.example/x.webp');
  assert.equal(image.mediaType, 'image/png');
});

test('fetchFirstImage rejects oversize images and empty answers', async () => {
  await assert.rejects(
    fetchFirstImage(buildImageRequest('x', { apiKey: 'k' }), {
      maxBytes: 4,
      fetchImpl: async () => jsonResponse({ data: [{ b64_json: b64('way-too-many-bytes') }] }),
    }),
    (error) => error instanceof ImageProviderError && error.code === 'image_too_large',
  );
  await assert.rejects(
    fetchFirstImage(buildImageRequest('x', { apiKey: 'k' }), {
      fetchImpl: async () => jsonResponse({ data: [] }),
    }),
    (error) => error instanceof ImageProviderError && error.code === 'image_protocol',
  );
});

test('fetchFirstImage maps provider failures to safe errors that never leak the key', async () => {
  const key = 'super-secret-key';
  const error = await fetchFirstImage(buildImageRequest('x', { apiKey: key }), {
    fetchImpl: async () => jsonResponse({ error: { message: 'bad key ' + key } }, 401),
  }).catch((e) => e);
  assert.ok(error instanceof ImageProviderError);
  assert.equal(error.status, 502);
  assert.ok(!error.message.includes(key), 'the safe message must not contain the key');
});

test('fetchFirstImage reports a network failure without the key', async () => {
  const error = await fetchFirstImage(buildImageRequest('x', { apiKey: 'k' }), {
    fetchImpl: async () => {
      throw new Error('socket hangup');
    },
  }).catch((e) => e);
  assert.ok(error instanceof ImageProviderError);
  assert.equal(error.code, 'image_network');
  assert.equal(error.status, 502);
});

await rm(dir, { recursive: true, force: true });
