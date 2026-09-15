// A browser request that cannot wait forever.
//
// Every panel on the chat surface fetched with a bare `fetch` and a `let live`
// boolean — no signal, no timeout. That is fine while the server answers, and
// this server is single-threaded and writes SQLite synchronously while a run
// streams, so "busy" is a state it genuinely reaches. A request with no
// deadline then never settles and the panel keeps its skeleton forever, which
// is what "the frontend hangs" looked like from the outside.
//
// Run: node --test tests/client-request.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFetch, RequestFailed, DEFAULT_TIMEOUT_MS } from '../lib/client/request.ts';

const original = globalThis.fetch;
const restore = () => {
  globalThis.fetch = original;
};

test('a request that never comes back fails, and says it timed out', async () => {
  const alive = setTimeout(() => {}, 5_000);
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  try {
    await assert.rejects(
      () => clientFetch('/api/anything', { timeoutMs: 40 }),
      (error) => {
        assert.ok(error instanceof RequestFailed, 'the failure should be typed');
        assert.equal(error.timedOut, true, 'and should say it was the clock, not the server');
        return true;
      },
    );
  } finally {
    clearTimeout(alive);
    restore();
  }
});

test("the caller's own signal still cancels, and is not replaced by the deadline", async () => {
  let sawAbort = false;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const controller = new AbortController();
  const inFlight = clientFetch('/api/anything', { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  try {
    await assert.rejects(() => inFlight);
    assert.ok(sawAbort, 'unmounting a panel must still stop its request');
  } finally {
    restore();
  }
});

test('the default deadline is a length a person would wait', () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 5_000, 'too short to survive a slow phone on a slow network');
  assert.ok(DEFAULT_TIMEOUT_MS <= 30_000, 'long enough that the page just looks broken');
});

test('every browser fetch on the chat surface goes through the helper', async () => {
  // The point of the helper is that nothing is left on a bare fetch. This is
  // the assertion that keeps it true as panels are added.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const offenders = [];
  for (const dir of ['components/chat', 'hooks']) {
    for (const name of readdirSync(join(root, dir))) {
      if (!/\.tsx?$/.test(name)) continue;
      const source = readFileSync(join(root, dir, name), 'utf8');
      // `clientFetch(` and `requestJson(` are fine; a bare `fetch(` is not.
      for (const match of source.matchAll(/(^|[^.\w])fetch\(/g)) {
        const before = source.slice(Math.max(0, match.index - 12), match.index + 1);
        if (/client|typeof |globalThis\./.test(before)) continue;
        offenders.push(`${dir}/${name}`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    'these still use a bare fetch, so they can wait forever',
  );
});
