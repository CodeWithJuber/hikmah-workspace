/** Compile design/hikmah-theme.ts into app/styles/palette.generated.css.
 *
 * A wrapper rather than the CLI directly, for two reasons. `astryx theme build`
 * also writes `<name>.js`, `<name>.d.ts` and sometimes `<name>.variants.d.ts`
 * beside its output — the runtime module for apps that render Astryx
 * components, which this app does not. Building into a temporary directory and
 * copying only the stylesheet keeps those out of the repo, where they would
 * otherwise be unreachable files the toolchain has to be told to ignore.
 *
 * And `--check` gives CI a way to fail when the committed CSS no longer matches
 * its source, which is the failure mode of every committed generated file.
 *
 *   node scripts/build-design.mjs            write it
 *   node scripts/build-design.mjs --check    fail if it is stale
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'design/hikmah-theme.ts');
const target = join(root, 'app/styles/palette.generated.css');
const cli = join(root, 'node_modules/@astryxdesign/cli/clients/cli/bin/astryx.mjs');

const out = join(mkdtempSync(join(tmpdir(), 'hikmah-design-')), 'palette.generated.css');
execFileSync(process.execPath, [cli, 'theme', 'build', source, '-o', out], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});
// The generator stamps the command it was run with, including the output path,
// which is a temp directory here and so differs on every run. Rewritten to the
// command a person would actually type: deterministic, and more use to whoever
// reads the header wondering how to regenerate it.
const built = readFileSync(out, 'utf8').replace(
  /^ \* Command: .*$/m,
  ' * Command: npm run design:build',
);

if (process.argv.includes('--check')) {
  const committed = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (committed !== built) {
    console.error(
      'app/styles/palette.generated.css is stale.\n' +
        'It no longer matches design/hikmah-theme.ts — run `npm run design:build`.',
    );
    process.exit(1);
  }
  console.info('design: the committed palette matches its source');
} else {
  writeFileSync(target, built);
  console.info(`design: wrote app/styles/palette.generated.css (${built.length} bytes)`);
}
