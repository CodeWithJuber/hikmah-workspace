// Running JavaScript in-process, with no workbench and no network.
//
// The interpreter was the owner's original complaint and the fix only ever
// landed on the workspace surface; the durable one had sandbox_run, which needs
// a container. These run real programs through the tool the model is handed,
// because the failure that mattered last time was invisible to every unit test:
// the build was green and every run failed in the browser.
// Run: node --test tests/javascript-tool.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { javascriptTools } from '../lib/ai/tools/javascript.ts';

const run = (code) => javascriptTools().run_javascript.execute({ code });

test('a program runs and returns what it printed and what it evaluated to', async () => {
  const out = await run('console.log("counting"); 6 * 7');
  assert.equal(out.stdout, 'counting');
  assert.equal(out.result, '42');
  assert.equal(out.error, undefined);
  assert.ok(typeof out.elapsedMs === 'number');
});

test('a thrown error comes back as a result, not as a failed run', async () => {
  // The model can read this and correct itself; throwing would end the run.
  const out = await run('throw new Error("deliberate")');
  assert.match(out.error, /deliberate/);
  assert.equal(out.stdout, '');
});

test('the interpreter has no way out of the process', async () => {
  for (const probe of ['typeof require', 'typeof process', 'typeof fetch', 'typeof globalThis.fs'])
    assert.equal((await run(probe)).result, 'undefined', probe);
});

test('a program that will not stop is interrupted rather than hanging the worker', async () => {
  const out = await run('while (true) {}');
  assert.ok(out.error, 'an endless loop must end in an error');
  // The interrupt fires at three seconds; anything near a minute means the
  // handler is not wired and the worker would be stuck behind one tool call.
  assert.ok(out.elapsedMs === undefined || out.elapsedMs < 10_000, `took ${out.elapsedMs}ms`);
});

test('output is capped rather than flooding the transcript', async () => {
  const out = await run('for (let i = 0; i < 100000; i++) console.log("x".repeat(100))');
  assert.ok(out.error, 'the cap reports itself');
  assert.ok((out.stdout ?? '').length <= 24_000);
});

test('source longer than the limit is refused before it runs', async () => {
  const out = await run('//' + 'x'.repeat(40_001));
  assert.match(out.error, /40,000/);
});

test('the module is booted once, so a second program is not paying for start-up', async () => {
  // The worker is long-lived. Re-instantiating WebAssembly per call would spend
  // the program's own three-second budget before it ran, which is exactly how
  // the browser build used to report timeouts on a first run.
  await run('1');
  const started = Date.now();
  const out = await run('2 + 2');
  assert.equal(out.result, '4');
  assert.ok(Date.now() - started < 1500, 'a warm run should be immediate');
});
