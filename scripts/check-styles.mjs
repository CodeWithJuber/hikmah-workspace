/** A ratchet on the one stylesheet.
 *
 * app/globals.css accumulated 220 distinct colours across 338 uses — 177 of
 * them used exactly once — and 265 selectors defined more than once. That is
 * why editing a rule often did nothing (another copy further down won) and why
 * no two screens quite matched: each was patched where it was rather than
 * where the rule lived.
 *
 * Both numbers are now lower and this stops them climbing back. It is a
 * ratchet, not a rule: the baselines are what the file measured when the last
 * pass finished, and the only accepted direction is down. Lower one when you
 * lower the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'app/globals.css');
const css = readFileSync(file, 'utf8');
/** Blank out comments, leaving the file's length and line structure intact.
 *
 * Not a regex, because `/*` also occurs inside strings: every `@source` glob
 * ends `dist/*.js`. A regex opener there ran to the next real `*\/` and blanked
 * 3,393 characters of live CSS — the whole shadcn token block among them — so
 * this check was silently ignoring part of the file it guards, and its colour
 * baseline was an undercount of exactly that much. It surfaced when a change
 * that added one comment moved which region got swallowed, and 13 colours
 * appeared to spring into existence.
 *
 * So strings are tracked, and a `/*` inside one is what it is: two characters
 * of a filename. */
function withoutComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep newlines so anything reported by line still lines up.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}
const bare = withoutComments(css);

const colours = new Set([...bare.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()));

/* Counted per at-rule context, not per selector.
 *
 * A rule restated inside `@media (max-width: 600px)` is not a duplicate of the
 * one outside it — that is how a responsive override is written, and there is
 * no other way to write one. Counting the two together made this check
 * penalise adding a breakpoint, which is the opposite of what it is for: the
 * chat surface had no rule below 600px at all, and the first one added tripped
 * the ratchet. Two definitions in the *same* context are still drift, which is
 * the thing being ratcheted. */
const seen = new Map();
const context = [];
for (const [, preludeRaw, brace] of bare.matchAll(/([^{}]*)([{}])/g)) {
  if (brace === '}') {
    context.pop();
    continue;
  }
  const prelude = preludeRaw.trim().replace(/\s+/g, ' ');
  // An at-rule opens a block and names the context its rules live in; a style
  // rule opens one too, so both are pushed and the depth stays honest.
  context.push(prelude.startsWith('@') ? prelude : null);
  if (prelude.startsWith('@')) continue;
  const where = context.filter(Boolean).join(' ');
  for (const selector of prelude
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[.#[]/.test(s))) {
    const key = where ? where + ' { ' + selector : selector;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
}
const repeated = [...seen].filter(([, n]) => n > 1);
const extra = repeated.reduce((total, [, n]) => total + n - 1, 0);

/* 131 until the comment scanner above was fixed. The file never had 131
 * colours: 13 of them sat in the 3,393 characters this check could not see,
 * and both the pre-layer and post-layer file measure 144 once it can. Raised
 * because the measurement was wrong, not because the file grew — the only
 * reason a ratchet may ever go up. */
const BASELINE = { colours: 144, repeated: 100, extra: 138 };
const actual = { colours: colours.size, repeated: repeated.length, extra };

const grown = Object.entries(BASELINE).filter(([key, limit]) => actual[key] > limit);
if (grown.length) {
  console.error('app/globals.css moved in the wrong direction:\n');
  for (const [key, limit] of grown) console.error(`  ${key}: ${actual[key]}, was ${limit}`);
  console.error(
    [
      '',
      'A new colour that is nearly one we already have, or a second definition',
      'of a selector that already exists, is how this file became unreadable.',
      'Reuse the token, or extend the rule where it lives.',
      '',
      'If the growth is deliberate, raise the baseline in this file and say why',
      'in the commit.',
    ].join('\n'),
  );
  process.exit(1);
}

// Tightening happens by hand, so the ratchet cannot silently drift upward
// after a refactor that improved things.
const slack = Object.entries(BASELINE).filter(([key, limit]) => actual[key] < limit);
if (slack.length && process.argv.includes('--update')) {
  const next = readFileSync(new URL(import.meta.url), 'utf8').replace(
    /const BASELINE = \{[^}]*\};/,
    `const BASELINE = { colours: ${actual.colours}, repeated: ${actual.repeated}, extra: ${actual.extra} };`,
  );
  writeFileSync(fileURLToPath(import.meta.url), next);
  console.info('Baseline lowered to', actual);
} else {
  console.info(
    `styles: ${actual.colours} colours, ${actual.repeated} selectors defined more than once ` +
      `(${actual.extra} extra)` +
      (slack.length ? ' — below baseline; run with --update to lock it in' : ''),
  );
}
