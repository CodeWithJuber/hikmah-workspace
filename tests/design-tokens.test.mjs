// The generated design language, and the three claims this repo relies on.
//
// Astryx is a two-week-old package on a fortnightly cadence, and the file it
// writes is committed source. These are the properties that, if a CLI upgrade
// changed them, would be invisible in review and wrong in the browser.
// Run: node --test tests/design-tokens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// Shared by the two contrast tests below.
const contrast = () => {
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

  return { pair, ratio };
};

test('the accent carries its own label in both colour modes', () => {
  // The generator guarantees contrast for what IT derives. --ax-accent and
  // --ax-on-accent are both written by hand in design/hikmah-theme.ts, which
  // the template says plainly makes that pair ours to check.
  const { pair, ratio } = contrast();
  const [accentLight, accentDark] = pair('--ax-accent');
  const [onLight, onDark] = pair('--ax-on-accent');
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

test('a field edge is findable against the page it sits on', () => {
  // WCAG 2.2 holds a UI component's boundary to 3:1, which is a different rule
  // from the text one and not something the generator promises: derived, the
  // dark value was 2.93:1 on the pinned dark body — a field you cannot quite
  // see. Both halves are pinned in design/hikmah-theme.ts now, so this is the
  // check that says why, and the one that fails if a CLI upgrade re-derives
  // them.
  const { pair, ratio } = contrast();
  const [edgeLight, edgeDark] = pair('--ax-border-emphasized');
  const [bodyLight, bodyDark] = pair('--ax-background-body');
  for (const [mode, edge, body] of [
    ['light', edgeLight, bodyLight],
    ['dark', edgeDark, bodyDark],
  ]) {
    const value = ratio(edge, body);
    assert.ok(
      value >= 3,
      `${mode}: the input edge ${edge} on ${body} is ${value.toFixed(2)}:1, under 3`,
    );
  }
});

test('the palette is imported, so the graph-following checks see it', () => {
  assert.ok(allStyles().includes('@generated'), 'globals.css no longer imports the palette');
});

test('the generated palette and Tailwind’s theme namespace share no name', () => {
  // `--color-*` is Tailwind's theme namespace, and it was Astryx's too. Both
  // write to :root, `theme` sorts after `astryx-theme`, so Tailwind's entry
  // replaced the generated one — and because globals.css declares
  // `--color-accent: var(--accent)` while tokens.css built `--accent` from
  // `--color-accent`, the two closed a reference cycle. CSS resolves a cycle by
  // discarding every property in it, so the brand green stopped existing:
  // measured across six surfaces, 1,942 borderColor and 1,566 color
  // declarations changed, the mark rendered black, and `border: 1px solid
  // color-mix(…var(--primary)…)` lost its whole shorthand — width, style and
  // colour — taking the onboarding card's border and background with it.
  //
  // Nothing in the build says the two namespaces must stay apart, and the
  // failure is silent in review and in the console. This says it.
  const generated = new Set([...palette.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const theme = globals.slice(globals.indexOf('@theme inline'));
  const declared = new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const shared = [...declared].filter((name) => generated.has(name));
  assert.deepEqual(
    shared,
    [],
    `${shared.join(', ')} is declared by both the generated palette and @theme, ` +
      'so whichever layer sorts last silently wins. Rename one side.',
  );
});

test('the focus ring is opaque and clears 3:1 against its neighbours', () => {
  // P0-2: the old 50%-alpha accent ring measured ~2.2:1 — an outright WCAG
  // 1.4.11 failure, and axe does not check this. The ring is now the opaque
  // --focus-ring token (near-black in light, white in dark), which is why it
  // must never come back as a translucent accent.
  const tokens = readFileSync(new URL('../app/styles/tokens.css', import.meta.url), 'utf8');
  const match = tokens.match(
    /--focus-ring:\s*light-dark\(var\(--ax-text-primary\),\s*(#[0-9a-fA-F]{6})\)/,
  );
  assert.ok(match, '--focus-ring is not the theme-paired token it must be');
  const darkRing = match[1];

  const { pair, ratio } = contrast();
  const [textLight] = pair('--ax-text-primary');
  const [, bodyDark] = pair('--ax-background-body');
  const [edgeLight, edgeDark] = pair('--ax-border-emphasized');
  const checks = [
    ['light', textLight, '#ffffff', 'page'],
    ['light', textLight, edgeLight, 'input edge'],
    ['dark', darkRing, bodyDark, 'page'],
    ['dark', darkRing, edgeDark, 'input edge'],
  ];
  for (const [mode, ring, adjacent, where] of checks) {
    const value = ratio(ring, adjacent);
    assert.ok(
      value >= 3,
      `${mode}: the focus ring ${ring} on ${where} ${adjacent} is ${value.toFixed(2)}:1, under 3`,
    );
  }

  const uiDir = new URL('../components/ui/', import.meta.url);
  const translucent = readdirSync(uiDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, text: readFileSync(new URL(f, uiDir), 'utf8') }))
    .filter(({ text }) => /ring\/50|ring-ring\/\d+/.test(text));
  assert.deepEqual(
    translucent.map((f) => f.file),
    [],
    'translucent focus rings are back in components/ui: ' +
      translucent.map((f) => f.file).join(', '),
  );
});

test('the motion ladder is codified and the primitives reference it', () => {
  // P2-11: three durations, two easings, one vocabulary. The button press is
  // its own asymmetry (80ms down, 200ms back, 0.96 scale). This fails if a
  // token is renamed or a primitive drifts back to a magic number.
  const tokens = readFileSync(new URL('../app/styles/tokens.css', import.meta.url), 'utf8');
  for (const [name, value] of [
    ['--motion-micro', '150ms'],
    ['--motion-ui', '250ms'],
    ['--motion-surface', '350ms'],
    ['--ease-enter', 'cubic-bezier(0.16, 1, 0.3, 1)'],
    ['--ease-exit', 'cubic-bezier(0.3, 0, 1, 1)'],
  ]) {
    assert.match(tokens, new RegExp(`${name}:\\s*${value.replace(/[().,]/g, (c) => `\\${c}`)}`));
  }

  const base = readFileSync(new URL('../app/styles/base.css', import.meta.url), 'utf8');
  // The button press: 80ms down to 0.96, 200ms back on the exit easing.
  assert.match(base, /\.icon-button:not\(:disabled\):active\s*\{[^}]*scale: 0\.96/);
  assert.match(base, /transition:\s*scale 200ms var\(--ease-exit\)/);

  const button = readFileSync(new URL('../components/ui/button.tsx', import.meta.url), 'utf8');
  assert.ok(button.includes('active:scale-[0.96]'), 'button lost its press scale');
  assert.ok(button.includes('active:duration-[80ms]'), 'button lost its 80ms press');
  assert.ok(button.includes('ease-[var(--ease-exit)]'), 'button lost its exit easing');

  const switchFile = readFileSync(new URL('../components/ui/switch.tsx', import.meta.url), 'utf8');
  assert.ok(switchFile.includes('duration-[var(--motion-micro)]'), 'switch left the ladder');

  for (const file of ['../components/ui/dialog.tsx', '../components/ui/alert-dialog.tsx']) {
    const dialog = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(dialog.includes('duration-[var(--motion-surface)]'), `${file} left the ladder`);
    assert.ok(dialog.includes('duration-[var(--motion-ui)]'), `${file} overlay left the ladder`);
    assert.ok(dialog.includes('ease-[var(--ease-enter)]'), `${file} lost its enter easing`);
  }
});
