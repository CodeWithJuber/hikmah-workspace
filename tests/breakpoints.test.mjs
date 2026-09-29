// The breakpoint ladder is documented in app/styles/tokens.css and mirrored
// in lib/ui/breakpoints.ts (CSS cannot use var() in @media). These keep the
// two from drifting, and keep new stylesheets on the ladder instead of
// inventing per-component breakpoints.
// Run: node --test tests/breakpoints.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREAKPOINTS, maxQuery, minQuery, isPhoneViewport } from '../lib/ui/breakpoints.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = readFileSync(resolve(root, 'app/styles/tokens.css'), 'utf8');

test('tokens.css documents the same ladder lib/ui/breakpoints.ts exports', () => {
  for (const [name, px] of Object.entries(BREAKPOINTS)) {
    assert.ok(
      tokens.includes(`bp-${name}: ${px}px`),
      `tokens.css must document bp-${name}: ${px}px`,
    );
  }
});

test('the ladder covers the owner-asked range 360–1280', () => {
  assert.deepEqual(Object.values(BREAKPOINTS), [360, 480, 768, 1024, 1280]);
});

test('query builders emit the documented values', () => {
  assert.equal(maxQuery('md'), '(max-width: 768px)');
  assert.equal(minQuery('lg'), '(min-width: 1024px)');
});

test('phone detection matches the tablet boundary', () => {
  assert.equal(isPhoneViewport(360), true);
  assert.equal(isPhoneViewport(767), true);
  assert.equal(isPhoneViewport(768), false);
});

test('fluid type tokens exist and are clamp()-based', () => {
  for (const token of ['--text-display', '--text-title', '--text-headline']) {
    const match = tokens.match(new RegExp(`${token}:\\s*([^;]+);`));
    assert.ok(match, `${token} must be defined in tokens.css`);
    assert.ok(match[1].includes('clamp('), `${token} must be fluid (clamp()), got: ${match[1]}`);
  }
});

test('adaptive spacing tokens exist', () => {
  for (const token of ['--space-page-x', '--space-section', '--space-card']) {
    assert.ok(tokens.includes(token), `${token} must be defined in tokens.css`);
  }
});

test('new native stylesheets stay on the ladder (no rogue breakpoints)', () => {
  // Every @media width in the native layer must be a ladder value or the
  // shell's documented 900/901px chrome switch — nothing hand-picked per rule.
  const allowed = new Set([...Object.values(BREAKPOINTS), 900, 901]);
  for (const file of ['native-motion.css', 'native-ui.css']) {
    const css = readFileSync(resolve(root, 'app/styles', file), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ' ',
    );
    for (const m of css.matchAll(/@media\s*\([^)]*?(\d+)px/g)) {
      assert.ok(
        allowed.has(Number(m[1])),
        `${file}: @media uses ${m[1]}px, which is not on the breakpoint ladder`,
      );
    }
  }
});
