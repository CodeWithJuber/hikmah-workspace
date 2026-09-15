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
import { allStyles, styleFiles } from './stylesheet.mjs';

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
  // them were there to beat unlayered rules that had already won. Layers made
  // them unnecessary rather than removing them; the surface PRs remove them.
  // Target: 0.
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

test('three breakpoints, not thirteen', () => {
  const widths = new Set([...css.matchAll(/@media[^{]*?(\d+)px/g)].map((m) => Number(m[1])));
  // 480, 600, 650, 699, 700, 760, 767, 900, 1100, 1179, 1180, 1350, 1600 — and
  // 699/700 and 1179/1180 are the same boundary written twice, once as `max-`
  // and once as `min-`, four times over. A layout that changes at thirteen
  // widths was not designed at any of them. Target: 3.
  atMost(widths.size, 13, 'distinct @media widths', [...widths].sort((a, b) => a - b).join(' '));
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
