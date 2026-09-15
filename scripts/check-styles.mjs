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
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'app/globals.css');

/** Packages whose stylesheets may be imported by name.
 *
 * Anything else arriving from node_modules fails the check. A palette is one
 * `@import` away from being invisible to everything below, and that is how
 * `vendor/shadcn-tailwind-4.13.0.css` had already arrived unseen. */
const ALLOWED_PACKAGES = new Set(['tailwindcss', 'tw-animate-css', 'katex/dist/katex.min.css']);

/** Every stylesheet the page actually loads from this repo.
 *
 * Following the graph rather than reading one path is what lets globals.css be
 * split without blinding this check: a new file is scanned the moment it is
 * imported, and a file nobody imports does not ship. It also gives `repeated`
 * cross-file reach it never had — a selector defined in two of our files is
 * the same drift as two definitions in one.
 */
function stylesheetGraph(from) {
  const seenFiles = new Set();
  const sources = [];
  const visit = (path) => {
    const key = resolve(path);
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    const text = readFileSync(key, 'utf8');
    sources.push({ path: relative(root, key), text });
    for (const [, spec] of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('.') || spec.startsWith('/')) visit(join(dirname(key), spec));
      else if (!ALLOWED_PACKAGES.has(spec)) {
        console.error(`${relative(root, key)} imports '${spec}' from node_modules.`);
        console.error(
          'Styles that arrive this way are invisible to every rule below. Add it to\n' +
            'ALLOWED_PACKAGES with the reason, or vendor it under vendor/ where it is read.',
        );
        process.exit(1);
      }
    }
  };
  visit(from);
  return sources;
}

const sheets = stylesheetGraph(entry);
const css = sheets.map((s) => s.text).join('\n');
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

/** A colour moved into a component is still a colour.
 *
 * `style={{ color: '#abc' }}` and `bg-[#abc]` are the other way a hex escapes
 * a stylesheet, and counting only CSS would reward moving one there. The two
 * vendored directories are excluded: they are replaced wholesale by
 * `npx shadcn add` and `npx ai-elements add`, so their colours are not ours to
 * reuse or retire. */
const VENDORED = ['components/ui', 'components/ai-elements'];

/** Files whose colours are not ours to choose.
 *
 * A "Sign in with Google" button has to wear Google's four brand colours, and
 * counting them would put four permanently unfixable entries in the way of the
 * goal this check is walking toward: no hand-written colour anywhere. Anything
 * added here needs a reason of that kind, not convenience. */
const BRAND_MARKS = new Set(['components/auth/google-button.tsx']);
const markup = [];
const walkMarkup = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const here = relative(root, full);
    if (VENDORED.includes(here) || BRAND_MARKS.has(here)) continue;
    if (statSync(full).isDirectory()) walkMarkup(full);
    else if (extname(full) === '.tsx') markup.push(full);
  }
};
for (const dir of ['app', 'components']) walkMarkup(join(root, dir));
for (const path of markup)
  for (const [hex] of readFileSync(path, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g))
    colours.add(hex.toLowerCase());

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

/* Every move this number has made, and why, because a ratchet nobody can audit
 * is just a number:
 *
 *   131       what the check reported before it could see the whole file
 *   -> 144    the comment scanner above was fixed; 13 colours had been sitting
 *             in 3,393 characters it was blanking. The file never grew
 *   -> 143    73 rules no source file refers to were deleted
 *   -> 149    the check began following the @import graph and reading hex out
 *             of .tsx markup. Six more were already there: one in the vendored
 *             shadcn sheet, four xterm fallbacks in terminal-panel.tsx, and
 *             the diagram strokes in playground/sound.tsx and maths.tsx
 *
 * Twice it went up because the measurement got honest, never because the file
 * did. That is the only reason it may. */
const BASELINE = { colours: 149, repeated: 95, extra: 133 };
const actual = { colours: colours.size, repeated: repeated.length, extra };

const grown = Object.entries(BASELINE).filter(([key, limit]) => actual[key] > limit);
if (grown.length) {
  console.error('the stylesheets moved in the wrong direction:\n');
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
