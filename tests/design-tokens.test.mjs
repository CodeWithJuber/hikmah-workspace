// The generated design language, and the three claims this repo relies on.
//
// Astryx is a two-week-old package on a fortnightly cadence, and the file it
// writes is committed source. These are the properties that, if a CLI upgrade
// changed them, would be invisible in review and wrong in the browser.
// Run: node --test tests/design-tokens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allStyles } from './stylesheet.mjs';

const palette = readFileSync(
  new URL('../app/styles/palette.generated.css', import.meta.url),
  'utf8',
);

test('it is marked generated, which is what exempts it from the colour ratchet', () => {
  // scripts/check-styles.mjs scores a file with this header separately. Without
  // it, 87 derived colours would be counted as hand-written drift and bury the
  // number that check exists to drive to zero.
  assert.match(palette.slice(0, 400), /@generated\b/);
  assert.match(palette, /Source: design\/hikmah-theme\.ts/);
});

test('the theme follows the stamped attribute, never the operating system', () => {
  // The layout stamps data-theme from a cookie before first paint, and that
  // preference always wins. A prefers-color-scheme rule here could only ever
  // paint the wrong colour for a frame — or, worse, disagree with the cookie.
  assert.equal(palette.includes('prefers-color-scheme'), false);
  assert.match(palette, /html\[data-theme="light"\]\s*\{\s*color-scheme: light;/);
  assert.match(palette, /html\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  assert.match(palette, /:root\s*\{\s*color-scheme: light dark;/);
});

test('nothing but color-scheme applies until <html> carries the theme attribute', () => {
  // This is the load-bearing claim: the palette ships, and defines nothing,
  // until something opts in. If a future version emitted an unscoped token
  // block it would start overriding the app's own :root the moment it was
  // imported, which is exactly the change that would not show up in a diff.
  const declarations = palette
    .split('\n')
    .map((line, i) => ({ line: line.trim(), i }))
    .filter((l) => /^--[\w-]+:/.test(l.line));
  assert.ok(declarations.length > 50, 'the palette should define plenty of tokens');

  const scopeAt = palette.indexOf('@scope ([data-astryx-theme="hikmah"])');
  assert.ok(scopeAt > -1, 'the tokens are no longer scoped to the theme attribute');
  const firstTokenAt = palette.indexOf(declarations[0].line);
  assert.ok(
    firstTokenAt > scopeAt,
    'a custom property is declared before the first @scope, so it applies unconditionally',
  );
});

test('the accent carries its own label in both colour modes', () => {
  // The generator guarantees contrast for what IT derives. --color-accent and
  // --color-on-accent are both written by hand in design/hikmah-theme.ts, which
  // the template says plainly makes that pair ours to check.
  const pair = (name) => {
    const m = palette.match(
      new RegExp(`${name}: light-dark\\((#[0-9a-fA-F]{3,8}), (#[0-9a-fA-F]{3,8})\\)`),
    );
    assert.ok(m, `${name} is not a light-dark() pair of hex colours`);
    return [m[1], m[2]];
  };
  const luminance = (hex) => {
    const n =
      hex.length === 4
        ? [...hex.slice(1)].map((c) => parseInt(c + c, 16))
        : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = n.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const [accentLight, accentDark] = pair('--color-accent');
  const [onLight, onDark] = pair('--color-on-accent');
  for (const [mode, fill, label] of [
    ['light', accentLight, onLight],
    ['dark', accentDark, onDark],
  ]) {
    const value = ratio(fill, label);
    assert.ok(
      value >= 4.5,
      `${mode}: ${label} on ${fill} is ${value.toFixed(2)}:1, under the 4.5 a label needs`,
    );
  }
});

test('the palette is imported, so the graph-following checks see it', () => {
  assert.ok(allStyles().includes('@generated'), 'globals.css no longer imports the palette');
});
