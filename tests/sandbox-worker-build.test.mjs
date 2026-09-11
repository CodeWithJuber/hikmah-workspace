// The JavaScript sandbox is loaded as a pre-built ES module, and the reason is
// specific: Next's webpack emitted it as a classic worker and loaded its chunks
// with importScripts, which cannot parse the octal escapes QuickJS carries its
// WASM in. Every run failed with "Octal escape sequences are not allowed in
// template strings" — the runtime never started at all.
//
// The failure was build-shaped, so these assert the shape of the build.
// Run: node --test tests/sandbox-worker-build.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OUTPUT = 'public/sandbox-worker.js';

test('the worker builds, and is what the browser is asked to load', async () => {
  await run(process.execPath, ['scripts/build-sandbox-worker.mjs']);
  const bundle = await readFile(OUTPUT, 'utf8');

  // Everything QuickJS needs is inside: nothing to fetch, nothing to re-parse.
  assert.ok(bundle.length > 100_000, 'the runtime is bundled, not referenced');
  assert.doesNotMatch(
    bundle,
    /importScripts\s*\(/,
    'importScripts is the failure: a classic worker cannot load this runtime',
  );
  assert.doesNotMatch(bundle, /\brequire\s*\(/, 'a browser worker has no require');
});

test('the client loads the built module rather than bundling its own', async () => {
  // If this ever goes back to new URL(...) the app silently returns to the
  // broken webpack path, and the symptom is every run failing at once.
  const client = await readFile('lib/playground/sandbox-client.ts', 'utf8');
  assert.match(client, /new Worker\('\/sandbox-worker\.js', \{ type: 'module' \}\)/);
});

test('building the worker is part of building the app', async () => {
  // A worker that is only built by hand is a worker that is missing in
  // production, which is worse than the bug it fixes.
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(pkg.scripts.build, /build:worker/);
  assert.ok(pkg.scripts['build:worker']);
});

test('the runtime is compiled once, not per run', async () => {
  // Re-instantiating the WASM module on every call put the whole boot inside
  // the budget the program itself had, so a first run reported a timeout
  // instead of a result.
  const core = await readFile('lib/playground/sandbox-core.ts', 'utf8');
  assert.match(core, /export function quickJsModule/);
  assert.match(core, /module_ \?\?=/, 'the compiled module is cached');
});
