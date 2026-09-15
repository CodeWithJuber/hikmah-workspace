// The provider watchdog: a silent socket must not hang a run forever, and a
// slow-but-alive stream must not be cut off.
// Run: node --test tests/ai-watchdog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { withIdleTimeout } from '../lib/ai/watchdog.ts';

const read = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
};

/** A body that emits `chunks` with `gapMs` between them. */
const streamed = (chunks, gapMs) =>
  new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

test('a stream slower than the idle window still completes', async () => {
  // Four 30 ms gaps against a 90 ms idle budget: the total exceeds the budget,
  // so a wall-clock timeout would kill a healthy response. Each chunk resets it.
  const fetchIdle = withIdleTimeout(
    async () => new Response(streamed(['a', 'b', 'c', 'd'], 30)),
    90,
  );
  assert.equal(await read(await fetchIdle('https://example.test')), 'abcd');
});

test('a stream that goes silent is aborted with a readable message', async () => {
  const fetchIdle = withIdleTimeout(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            // then nothing, ever
          },
        }),
      ),
    60,
  );
  const response = await fetchIdle('https://example.test');
  await assert.rejects(read(response), /stopped sending data/);
});

test('the caller can cancel, so Stop really stops the provider request', async () => {
  const controller = new AbortController();
  const fetchIdle = withIdleTimeout(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    10_000,
  );
  const pending = fetchIdle('https://example.test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('a body-less response passes straight through', async () => {
  const fetchIdle = withIdleTimeout(async () => new Response(null, { status: 204 }), 50);
  const response = await fetchIdle('https://example.test');
  assert.equal(response.status, 204);
});

test('response status and headers survive the wrapper', async () => {
  const fetchIdle = withIdleTimeout(
    async () =>
      new Response(streamed(['ok'], 1), {
        status: 201,
        headers: { 'content-type': 'text/event-stream' },
      }),
    500,
  );
  const response = await fetchIdle('https://example.test');
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await read(response), 'ok');
});

test('a provider that trickles forever is still given up on', { timeout: 15000 }, async () => {
  // The idle deadline resets on every byte, deliberately: a long reasoning
  // response is healthy and a silent socket is dead. But that means one byte
  // every few seconds keeps a run — and a worker slot — alive with no end, and
  // nothing else in the system bounds it. So there is a second, much larger
  // bound on the whole response, far above any healthy answer.
  //
  // The trickle here is finite (400 chunks, ~2s) so that without the cap this
  // test fails in two seconds rather than hanging: a stream that never ends
  // makes a bad test, whatever it proves.
  let sent = 0;
  const trickle = new ReadableStream({
    async pull(controller) {
      if (sent >= 400) return controller.close();
      sent += 1;
      controller.enqueue(new TextEncoder().encode('.'));
      // Always faster than the idle deadline, so the idle path never fires.
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  const fetchBounded = withIdleTimeout(async () => new Response(trickle), 1_000, 200);
  const response = await fetchBounded('https://example.test');
  const reader = response.body.getReader();
  await assert.rejects(
    (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })(),
    /still sending/,
    'a response past the cap must end with a real message, not run to completion',
  );
  assert.ok(sent > 1, 'the stream really was flowing, so this is not the idle path');
});

test('a response that finishes inside the cap is untouched', async () => {
  const fetchBounded = withIdleTimeout(
    async () => new Response(new TextEncoder().encode('all of it')),
    1_000,
    10_000,
  );
  const response = await fetchBounded('https://example.test');
  assert.equal(await response.text(), 'all of it');
});
