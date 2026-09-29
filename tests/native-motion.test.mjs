// Every animation in the native layer must draw its duration and easing from
// tokens.css — a hard-coded `200ms` or `cubic-bezier(` in a stylesheet is how
// one motion language quietly becomes five. This is the static half of the
// "makhan" checklist; the other half is a device and an eye.
// Run: node --test tests/native-motion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const motion = strip(readFileSync(resolve(root, 'app/styles/native-motion.css'), 'utf8'));
const ui = strip(readFileSync(resolve(root, 'app/styles/native-ui.css'), 'utf8'));
const tokens = strip(readFileSync(resolve(root, 'app/styles/tokens.css'), 'utf8'));

test('the motion tokens the native layer needs all exist', () => {
  for (const token of [
    '--motion-micro',
    '--motion-ui',
    '--motion-surface',
    '--motion-tab',
    '--motion-press-down',
    '--motion-press-up',
    '--motion-shimmer',
    '--motion-pulse',
    '--ease-enter',
    '--ease-exit',
    '--ease-spring',
    '--ease-sheet',
    '--ease-press',
    '--press-scale',
    '--stagger-step',
    '--stagger-max',
  ]) {
    assert.ok(tokens.includes(token + ':'), `tokens.css must define ${token}`);
  }
});

test('no hard-coded durations in the native layer', () => {
  // A duration is `Nms`/`Ns` after a timing property or inside animation
  // shorthand — var(--motion-*) is the only legal spelling.
  for (const [name, css] of [
    ['native-motion.css', motion],
    ['native-ui.css', ui],
  ]) {
    const hard = [...css.matchAll(/(?:transition|animation)[^;{]*?(\d+(?:\.\d+)?m?s)(?![\w(])/g)]
      .map((m) => m[1])
      .filter((v) => v !== '0' && v !== '0s' && v !== '0ms');
    assert.deepEqual(hard, [], `${name}: hard-coded durations: ${hard.join(', ')}`);
  }
});

test('no hard-coded easing curves in the native layer', () => {
  for (const [name, css] of [
    ['native-motion.css', motion],
    ['native-ui.css', ui],
  ]) {
    const curves = [...css.matchAll(/cubic-bezier\(/g)].length;
    // linear and the named easings are fine; raw beziers belong in tokens.
    assert.equal(curves, 0, `${name}: raw cubic-bezier() curves — move them to tokens.css`);
  }
});

test('keyframes only touch transform and opacity', () => {
  // Layout-property animation is the definition of jank. The shimmer sweeps
  // a gradient via transform; the dot pulses opacity.
  const banned = /\b(width|height|top|left|right|bottom|margin|padding)\s*:/;
  for (const [name, css] of [
    ['native-motion.css', motion],
    ['native-ui.css', ui],
  ]) {
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g)) {
      assert.ok(!banned.test(m[2]), `${name}: @keyframes ${m[1]} animates a layout property`);
    }
  }
});

test('reduced-motion kills the native layer', () => {
  assert.ok(
    motion.includes('prefers-reduced-motion'),
    'native-motion.css must honour prefers-reduced-motion',
  );
  assert.ok(
    ui.includes('prefers-reduced-motion'),
    'native-ui.css must honour prefers-reduced-motion',
  );
});
