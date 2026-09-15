/** Every browser request has a deadline.
 *
 * lib/client/request.ts exists because twenty-five panels fetched with a bare
 * `fetch` and no signal. That is fine while the server answers, and this app's
 * server is single-threaded and writes SQLite synchronously while a run
 * streams, so "busy" is a state it reaches. A request with no deadline then
 * never settles, the panel keeps its skeleton, and the page looks hung — which
 * is what "the frontend hangs" turned out to mean.
 *
 * The helper landing did not finish the job: it was adopted on the chat surface
 * and eighteen call sites elsewhere kept the old shape. A count in a plan
 * cannot notice that. This can.
 *
 * Run: node --test tests/client-fetch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Requests that genuinely must not have a deadline, each for its own reason. */
const EXEMPT = new Map([
  [
    'components/vitals-reporter.tsx',
    'a keepalive beacon sent as the page closes — surviving that is the whole ' +
      'point, and aborting it would defeat it',
  ],
  [
    'components/ai-elements/prompt-input.tsx',
    'reads a blob: URL to make a data URL. No network, nothing to time out, ' +
      'and a vendored ai-elements file kept close to upstream',
  ],
]);

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

test('a browser request goes through clientFetch, or says why not', () => {
  const offenders = [];
  for (const file of ['components', 'hooks'].flatMap(sources)) {
    const text = readFileSync(join(root, file), 'utf8');
    // `fetch(` not preceded by a dot or word character, so clientFetch( and
    // window.fetch( in a comment do not count. Comments are stripped first.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const bare = [...code.matchAll(/(?<![.\w])fetch\(/g)].length;
    if (bare && !EXEMPT.has(file)) offenders.push(`${file} (${bare})`);
  }
  assert.deepEqual(
    offenders,
    [],
    'These call fetch directly, so they have no deadline and can leave a panel ' +
      `spinning forever:\n  ${offenders.join('\n  ')}\n` +
      'Use clientFetch from @/lib/client/request, or add the file to EXEMPT ' +
      'here with the reason it must not have one.',
  );
});

test('the exemptions are real, and still there', () => {
  // An exemption for a file that no longer fetches is a rule nobody is
  // following any more, and it would silently permit the next bare fetch added
  // to that file.
  for (const [file, why] of EXEMPT) {
    const text = readFileSync(join(root, file), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.ok(
      [...code.matchAll(/(?<![.\w])fetch\(/g)].length > 0,
      `${file} is exempt (${why}) but no longer calls fetch — drop the exemption.`,
    );
  }
});
