// A page written in the workspace can be opened as a page.
//
// The preview used to inline index.html, style.css and script.js into one
// srcdoc, so a page that linked css/style.css or js/script.js rendered
// unstyled inside the drawer, and nothing could open it full-screen or send a
// link to it. A preview is now served at /preview/<token>/<path>: the token is
// a signed, expiring reference to the workspace, so the page's relative links
// resolve and no cookie is needed — which is what lets a sandboxed frame (an
// opaque origin, no credentials) fetch its own stylesheet.
// Run: node --test tests/preview-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_TTL_MS,
  contentTypeFor,
  previewPath,
  signPreviewToken,
  verifyPreviewToken,
  withConsoleBridge,
} from '../lib/files/preview-link.ts';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;

test('a token names one workspace until it expires', () => {
  const token = signPreviewToken({ userId: 'user_abc', expiresAt: NOW + PREVIEW_TTL_MS }, SECRET);
  assert.match(token, /^[A-Za-z0-9_.-]+$/, 'safe inside a URL path segment');
  assert.deepEqual(verifyPreviewToken(token, SECRET, NOW), {
    userId: 'user_abc',
    expiresAt: NOW + PREVIEW_TTL_MS,
  });
  assert.equal(verifyPreviewToken(token, SECRET, NOW + PREVIEW_TTL_MS + 1), null, 'expired');
});

test('a token cannot be moved to another workspace, another secret, or forged', () => {
  const token = signPreviewToken({ userId: 'user_abc', expiresAt: NOW + 1000 }, SECRET);
  const [payload, signature] = token.split('.');
  const other = signPreviewToken({ userId: 'user_xyz', expiresAt: NOW + 1000 }, SECRET);
  assert.equal(verifyPreviewToken(other.split('.')[0] + '.' + signature, SECRET, NOW), null);
  assert.equal(verifyPreviewToken(payload + '.' + other.split('.')[1], SECRET, NOW), null);
  assert.equal(verifyPreviewToken(token, 't'.repeat(40), NOW), null);
  for (const junk of ['', 'a', 'a.b', payload, '../x', token + 'x'])
    assert.equal(verifyPreviewToken(junk, SECRET, NOW), null, JSON.stringify(junk));
});

test('the path under the token is the file path, and the root is index.html', () => {
  assert.equal(previewPath('tok', 'css/style.css'), '/preview/tok/css/style.css');
  assert.equal(previewPath('tok'), '/preview/tok/');
  assert.equal(previewPath('tok', 'index.html'), '/preview/tok/index.html');
});

test('each file is served as what it is', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('css/style.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('js/script.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('app.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('data.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('logo.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('notes.md'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeFor('Makefile'), 'text/plain; charset=utf-8');
});

test('the console bridge is added to a page once, ahead of its scripts', () => {
  const page =
    '<!doctype html><html><head><title>x</title></head><body><script>console.log(1)</script></body></html>';
  const bridged = withConsoleBridge(page);
  assert.equal(bridged.split('hikmah-preview').length - 1, 1);
  assert.ok(bridged.indexOf('hikmah-preview') < bridged.indexOf('console.log(1)'));
  assert.ok(
    withConsoleBridge('<p>no head</p>').startsWith('<script>'),
    'a bare fragment still gets one',
  );
});
