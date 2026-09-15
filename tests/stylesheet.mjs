/** The product's stylesheets, for tests that assert something about a rule.
 *
 * app/globals.css holds only directives and the import order now; every rule
 * lives in a file it imports. A test that reads globals.css alone and looks for
 * a rule would find nothing and pass — which is the quiet way a prohibition
 * stops being enforced. So `allStyles()` follows the same relative `@import`
 * graph `scripts/check-styles.mjs` does, and a file is covered from the moment
 * it is imported.
 *
 * `globals()` stays for the one thing that is genuinely about that file: what
 * order the imports are in, and that they come before any rule.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(root, 'app/globals.css');

export function globals() {
  return readFileSync(ENTRY, 'utf8');
}

/** globals.css and everything it imports from this repo, concatenated in
 * import order — which is also cascade order, so a test about which of two
 * rules wins reads them the way the browser does. */
export function allStyles() {
  const seen = new Set();
  const parts = [];
  const visit = (path) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    const text = readFileSync(key, 'utf8');
    // Imports first, then this file's own rules: an @import is hoisted, so a
    // rule in an imported file precedes the importing file's own.
    for (const [, spec] of text.matchAll(/@import\s+['"]([^'"]+)['"]/g))
      if (spec.startsWith('.') || spec.startsWith('/')) visit(join(dirname(key), spec));
    parts.push(text);
  };
  visit(ENTRY);
  return parts.join('\n');
}
