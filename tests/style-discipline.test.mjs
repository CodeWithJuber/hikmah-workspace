/** A ratchet on the design language itself, not just on its colours.
 *
 * scripts/check-styles.mjs counts distinct colours and repeated selectors,
 * which caught the drift that made the old 9,178-line stylesheet unreadable.
 * It says nothing about the other five ways a design language stops being one:
 * forty-nine different font sizes, a border radius chosen per rule, thirteen
 * breakpoints, a hundred and twenty `!important`, and `[data-slot=` written
 * wherever a component happened to need overriding.
 *
 * Every number below is what the stylesheets measured the day this file landed.
 * They are ceilings and the only accepted direction is down; each surface PR
 * lowers the ones it touches. Nothing here is a style preference — each is a
 * count of the same decision being made more than once.
 *
 * Run: node --test tests/style-discipline.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allStyles, styleFiles } from './stylesheet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Comments are prose about CSS, not CSS. Left in, `!important` in a sentence
 * explaining why one was removed would count as one. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const css = strip(allStyles());

/** A ratchet that says what it measured and where to look.
 *
 * `at most`, never `equals`: a test that fails when a number IMPROVES is a test
 * people learn to edit without reading, and then it stops catching anything. */
function atMost(actual, ceiling, what, detail = '') {
  assert.ok(
    actual <= ceiling,
    `${what}: ${actual}, was ${ceiling}. ${detail}\n` +
      'If this is deliberate, raise the ceiling in tests/style-discipline.test.mjs\n' +
      'and say why in the commit. Lower it whenever you lower the file.',
  );
}

test('!important, which is what fighting your own cascade looks like', () => {
  // 126 of these existed before app/globals.css was put in a layer, and most of
  // them were there to beat unlayered rules that had already won. Target: 0.
  //
  // But they are not free to delete, which was worth finding out before a
  // surface PR assumed otherwise. All 120 were stripped at once and the result
  // measured across 1,964 elements on six surfaces in both themes: **120
  // declarations changed** — near enough one per `!important`. Every page
  // heading's size and leading moved, and the workspace sidebar's padding went
  // from 26px to 8px. So each is currently load-bearing, and they come out one
  // rule at a time, by making that rule win on its own, with the audit run each
  // time. A blanket strip is a redesign nobody asked for.
  atMost(
    (css.match(/!important/g) ?? []).length,
    120,
    '!important declarations',
    'A layered rule does not need one. If it seems to, something above it is the bug.',
  );
});

test('one type scale, not thirty-nine sizes', () => {
  const sizes = new Set(
    [...css.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim().replace(/\s*!important$/, ''))
      .filter((value) => !value.startsWith('var(') && value !== 'inherit'),
  );
  // The generated palette carries a 12-step scale anchored at 14px, which is
  // already this app's dominant size. Every literal here is a size somebody
  // chose in one place without knowing what the next screen used — which is how
  // 17px, 19px and 21px all came to exist. Target: 0, every size a token.
  atMost(sizes.size, 39, 'distinct literal font sizes', [...sizes].sort().join(' '));
});

test('one radius scale', () => {
  const radii = new Set(
    [...css.matchAll(/border-radius:\s*([^;}]+)/g)]
      .map((m) => m[1].trim().replace(/\s*!important$/, ''))
      .filter((value) => !/^(var\(|50%|0|inherit|9999px|max\(var\()/.test(value)),
  );
  // The palette has six: none, inner, element, container, page, full. The file
  // has these. Target: 0.
  atMost(radii.size, 22, 'distinct literal border radii', [...radii].sort().join(' '));
});

test('colour comes from a token, or from mixing two', () => {
  // Counted as DECLARATIONS rather than distinct colours, which is what
  // check-styles.mjs already does: the same grey written in forty rules is one
  // colour and forty places to miss when it changes. Target: 0 — every colour a
  // var(), a color-mix(), transparent, currentColor or inherit.
  const declarations = [
    ...css.matchAll(
      /(?:^|[;{\s])(?:color|background|background-color|border-color|outline-color|fill|stroke|box-shadow|border(?:-top|-right|-bottom|-left|-inline-start|-inline-end)?):\s*([^;}]+)/g,
    ),
  ].map((m) => m[1]);
  const literal = declarations.filter((value) =>
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value),
  );
  atMost(literal.length, 178, 'declarations naming a colour literally', '');
});

test('the layout changes at as few widths as possible', () => {
  /* Counted as BOUNDARIES, not as numbers in the file, because the first
   * version of this check counted both wrong.
   *
   * It matched any `<digits>px` after `@media`, so `@media (max-height: 650px)`
   * — a rule about short windows, not narrow ones — was counted as a
   * breakpoint. And it counted `max-width: 699px` and `min-width: 700px` as two
   * boundaries when they are the standard way to write ONE: complementary, no
   * overlap, no gap. "699/700 is the same boundary written twice" was in the
   * commit message and it was wrong.
   *
   * What is left after fixing both is the real number, and it is still too
   * many: 480 600 700 760 767 900 1100 1179 1350 1600. A layout that changes at
   * ten widths was not designed at any of them. But merging them is a design
   * decision per surface, not a sweep — 900 belongs to the chat PR, 480 to
   * auth — so this walks down with those rather than in one step. */
  const boundaries = new Set();
  for (const [, query] of css.matchAll(/@media([^{]*)\{/g)) {
    for (const [, kind, size] of query.matchAll(/(min|max)-width:\s*(\d+)px/g)) {
      // A max-width of N-1 and a min-width of N are one boundary, named for the
      // min-width side.
      boundaries.add(kind === 'max' ? Number(size) + 1 : Number(size));
    }
  }
  atMost(
    boundaries.size,
    10,
    'distinct layout boundaries',
    [...boundaries].sort((a, b) => a - b).join(' '),
  );
});

test('[data-slot=] belongs in one file', () => {
  // Reaching into a vendored component's internals is sometimes the only way to
  // size it, but it has to be findable: when six files do it, the rule that
  // decides a button's height is wherever you last looked. The plan's
  // controls.css is that one file; until it exists this holds the count of
  // files, which is the number that matters.
  const owners = styleFiles().filter(
    (file) => !file.path.startsWith('vendor/') && strip(file.text).includes('[data-slot='),
  );
  atMost(
    owners.length,
    5,
    'files selecting on [data-slot=]',
    owners.map((file) => file.path).join(', '),
  );
});

test('the three properties that cost a composite on every frame', () => {
  // Not a count of what exists — a bound on what may. `backdrop-filter` and
  // `will-change` promote an element to its own layer for the life of the page;
  // `filter` re-rasterises it on every paint. On a two-core box, during a
  // streamed answer, that is spent at the moment this app has least to spare:
  // B1 and B3 took blocking time from 49s to ~3.5s and this is what stops a
  // redesign quietly buying it back.
  //
  // The first version of this test looked for these inside `.chat-transcript`,
  // a class that does not exist in this repo — the transcript is ai-elements
  // components with Tailwind classes — so it iterated an empty list and passed
  // no matter what. A vacuous check reads exactly like a clean one.
  const uses = (property) =>
    styleFiles()
      .filter((file) => !file.path.startsWith('vendor/') && !file.text.includes('@generated'))
      .flatMap((file) =>
        [...strip(file.text).matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:`, 'g'))].map(
          () => file.path,
        ),
      );
  // One: the blur behind an open dialog or sheet. It exists only while one is
  // open, so it never runs during a streamed answer — which is the distinction
  // this test is about, rather than the property being forbidden outright.
  atMost(
    uses('backdrop-filter').length,
    1,
    'backdrop-filter declarations',
    uses('backdrop-filter').join(', ') + ' — it promotes a layer for as long as it applies',
  );
  // None, and none is the ceiling: unlike the other two this one is permanent
  // by design, so the first has to argue for itself here rather than arrive
  // inside a surface PR.
  assert.deepEqual(
    uses('will-change'),
    [],
    'will-change promotes a layer for the page\u2019s life',
  );
  // Three, all hover states: `brightness(0.96)` on a button, `none` to undo it
  // on the ghost and outline variants, and `brightness(0.98)` on a workspace
  // row. A hover cannot fire on the phone this app is slowest on, and never
  // fires while an answer streams, so these are the cheap kind.
  atMost(uses('filter').length, 3, 'filter declarations', uses('filter').join(', '));
});

test('icons come from one scale', () => {
  // Twenty distinct sizes across 245 lucide `size={n}` uses, including a 19
  // that existed only to be one pixel off a 20, and a 17 one pixel off a 16.
  // Nobody chose twenty sizes; twenty people chose one each.
  //
  // Six steps: 12/16/20/24 for anything inside a control, and 32/48 for the
  // display marks on an empty state or a page header, which are pictures rather
  // than affordances and do not belong on the same scale as a chevron.
  const SCALE = new Set([12, 16, 20, 24, 32, 48]);
  const off = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      // Vendored, and replaced wholesale by their installers.
      if (full.endsWith('components/ui') || full.endsWith('components/ai-elements')) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.tsx'))
        for (const [, size] of readFileSync(full, 'utf8').matchAll(/size=\{(\d+)\}/g))
          if (!SCALE.has(Number(size))) off.push(`${relative(root, full)} size={${size}}`);
    }
  };
  for (const dir of ['app', 'components']) walk(join(root, dir));
  assert.deepEqual(off, [], 'icon sizes outside the scale');
});

test('a control is one of five heights', () => {
  // Twenty-five distinct heights on things you press or type into, between a
  // 25px span and a 46px field: 25, 26, 28, 30, 31, 34, 35, 38, 39, 42, 43, 45,
  // 46 and the five real ones. Four of them differed from a neighbour by a
  // single pixel, which nobody chose and nobody can see — but the composer's
  // send button being 38 in one file and 42 in another is the reason a row
  // never quite lined up.
  //
  // 24/32/36/40/44. The range is deliberate: below 20px is a hidden file input
  // or a slider track, and 47px and up is a card, a tab bar or a multi-line
  // field, whose height is a layout decision rather than a place on this scale.
  const SCALE = new Set([24, 32, 36, 40, 44]);
  const CONTROL =
    /button|\[data-slot|input|select|textarea|\.icon-button|trigger|tab\b|chip|pill|toggle/i;
  const off = [];
  for (const file of styleFiles()) {
    if (file.path.startsWith('vendor/') || file.text.includes('@generated')) continue;
    for (const [, selector, body] of strip(file.text).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const where = selector.trim().replace(/\s+/g, ' ');
      if (where.startsWith('@') || !CONTROL.test(where)) continue;
      for (const [, size] of body.matchAll(/(?:^|[;\s])(?:min-|max-)?height:\s*([0-9.]+)px/g)) {
        const height = Number(size);
        if (height < 20 || height > 46 || SCALE.has(height)) continue;
        off.push(`${file.path} ${where.slice(0, 50)} — ${height}px`);
      }
    }
  }
  assert.deepEqual(off, [], 'control heights off the scale');
});
