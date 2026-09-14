// The icon the browser asks for on every page.
//
// The app ships public/favicon.svg and declared nothing, so every page load
// asked for /favicon.ico, got a 404, and logged a console error — measured on
// the landing page, sign-in, sign-up and forgot-password. Declaring the icon in
// the root metadata is what stops the probe. This guards the pair: the
// declaration exists, and the file it names is really there.
// Run: node --test tests/site-icon.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the root metadata declares an icon, and the file it names exists', () => {
  const layout = readFileSync(join(root, 'app/layout.tsx'), 'utf8');
  const declaration = layout.match(/icons:\s*\{[\s\S]*?\}\s*,/);
  assert.ok(declaration, 'app/layout.tsx declares no icons, so /favicon.ico is requested and 404s');
  const urls = [...declaration[0].matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length, 'the icons declaration names no url');
  for (const url of urls) {
    assert.ok(url.startsWith('/'), `${url} is not rooted, so it resolves against the current path`);
    assert.ok(
      existsSync(join(root, 'public', url.slice(1))),
      `${url} is declared but public${url} does not exist`,
    );
  }
});
