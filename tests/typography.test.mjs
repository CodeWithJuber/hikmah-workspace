/** The typeface, pinned end to end.
 *
 * `font-family: Inter` sat in this repo's stylesheets from the first design
 * pass and nothing ever loaded Inter — no next/font, no @font-face, no
 * stylesheet link. Every device without it installed drew the fallback, and no
 * check could say so, because a stylesheet naming a font it does not have is
 * valid CSS that renders perfectly in something else. The bug was invisible by
 * construction.
 *
 * So this file asserts the whole chain rather than any one link: the package is
 * pinned and its two files exist, app/layout.tsx loads exactly those files,
 * <html> carries the class that defines the variable, and every rule that asks
 * for a sans family goes through that variable instead of naming Inter and
 * hoping. Break any one and the site silently renders in something else again.
 *
 * Run: node --test tests/typography.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allStyles, globals } from './stylesheet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const layout = read('app/layout.tsx');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

test('the font ships with the app, from a version that cannot change under us', () => {
  const pkg = JSON.parse(read('package.json'));
  const pinned = pkg.dependencies['@fontsource-variable/inter'];
  assert.ok(pinned, 'the font package is a dependency, not a hope about the device');
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/,
    `@fontsource-variable/inter is "${pinned}". Pin it exactly: a caret on a font ` +
      'package means the glyphs can change on an npm install, and nothing here would notice.',
  );

  // next/font/google would fetch these at build time from fonts.gstatic.com.
  // From the package they arrive through package-lock.json with an integrity
  // hash, which is the same reason vendor/ and the generated palette are
  // committed: a build that reaches the network can differ from the one before.
  const lock = JSON.parse(read('package-lock.json'));
  const entry = lock.packages['node_modules/@fontsource-variable/inter'];
  assert.equal(entry.version, pinned, 'the lockfile agrees with package.json');
  assert.ok(entry.integrity?.startsWith('sha512-'), 'the bytes are hashed in the lockfile');
});

test('app/layout.tsx loads the two files it references, and they exist', () => {
  const paths = [...layout.matchAll(/path:\s*'([^']*@fontsource-variable[^']*)'/g)].map(
    (m) => m[1],
  );
  assert.equal(paths.length, 2, 'one normal face and one italic, both variable-weight');

  for (const rel of paths) {
    const file = resolve(root, 'app', rel);
    assert.ok(existsSync(file), `next/font would fail the build on a missing ${rel}`);
    // Latin only, deliberately: Arabic and Urdu have no Inter glyphs, so the
    // browser falls back per glyph to the system's own — which is what should
    // happen, and which a full subset would not improve.
    assert.match(rel, /inter-latin-wght-(normal|italic)\.woff2$/, `${rel} is a latin wght axis`);
  }

  assert.match(layout, /variable:\s*'--font-inter'/, 'the loaded face is exposed as a variable');
  assert.match(layout, /display:\s*'swap'/, 'text is readable before the font arrives');
  // Without this the swap moves the page: the fallback is scaled to Inter's own
  // metrics, so the line rendered before the font arrives is the height it will
  // be after. Drop it and every screen shifts when 48 KB lands.
  assert.match(layout, /adjustFontFallback:\s*'Arial'/, 'the fallback is metric-adjusted');
});

test('<html> carries the class that defines the variable', () => {
  // The variable is scoped to whatever element gets `inter.variable`. On any
  // other element, every `font-family: var(--font-inter)` below resolves to
  // nothing, the declaration is invalid, and the whole site inherits the UA
  // font — the exact failure this file exists to catch.
  assert.match(layout, /<html[^>]*className=\{inter\.variable\}/, 'the class is on <html>');
});

test('Tailwind font-sans and every stylesheet rule read the variable', () => {
  assert.match(
    globals(),
    /--font-sans:\s*var\(--font-inter\)/,
    'the @theme bridge points at the loaded face, so every `font-sans` utility follows it',
  );

  const css = strip(allStyles());
  const families = [...css.matchAll(/font-family:\s*([^;}]+)/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  );
  assert.ok(families.length > 0, 'the stylesheets set a font family somewhere');

  // Naming the family directly is the bug: it renders correctly on a machine
  // that happens to have Inter and falls back everywhere else, which is how
  // this went unnoticed for five design generations.
  const named = families.filter((f) => /\bInter\b/i.test(f) && !f.includes('var(--font-inter)'));
  assert.deepEqual(
    named,
    [],
    'these name Inter instead of reading var(--font-inter), so they render it only ' +
      'on a device that already has it installed',
  );
});
