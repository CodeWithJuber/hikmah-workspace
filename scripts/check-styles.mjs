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
// Comments do not style anything, and a hex quoted in prose is not a colour.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

const colours = new Set([...bare.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()));

const seen = new Map();
for (const rule of bare.matchAll(/^\s*([.#[][^{}\n,]*(?:,\s*\n?\s*[^{}\n,]+)*)\s*\{/gm))
  for (const selector of rule[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    seen.set(selector, (seen.get(selector) ?? 0) + 1);
const repeated = [...seen].filter(([, n]) => n > 1);
const extra = repeated.reduce((total, [, n]) => total + n - 1, 0);

const BASELINE = { colours: 143, repeated: 265, extra: 359 };
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
