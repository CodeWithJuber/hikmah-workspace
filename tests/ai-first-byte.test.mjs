// The free-tier first-byte bound: a stream whose first item never comes must
// fail fast with an honest error, not stall for minutes. Later items stay
// unbounded — once an answer is flowing, a slow middle is fine.
// Run: node --test tests/ai-first-byte.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { withFirstByteLimit } from '../lib/ai/first-byte.ts';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* source(values, delayMs = 0) {
  for (const value of values) {
    if (delayMs) await tick(delayMs);
    yield value;
  }
}

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

test('items flow through when the first arrives in time', async () => {
  let timedOut = false;
  const out = await collect(
    withFirstByteLimit(
      source(['a', 'b', 'c']),
      500,
      () => {
        timedOut = true;
      },
      () => new Error('too slow'),
    ),
  );
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.equal(timedOut, false);
});

test('a missing first byte calls onTimeout and throws the made error', async () => {
  let timedOut = false;
  const slow = (async function* () {
    await tick(500);
    yield 'late';
  })();
  await assert.rejects(
    collect(
      withFirstByteLimit(
        slow,
        30,
        () => {
          timedOut = true;
        },
        () => new Error('queue busy'),
      ),
    ),
    /queue busy/,
  );
  assert.equal(timedOut, true);
});

test('only the first item is bounded: a slow second item still arrives', async () => {
  const slowSecond = (async function* () {
    yield 'a';
    await tick(120);
    yield 'b';
  })();
  const out = await collect(
    withFirstByteLimit(
      slowSecond,
      30,
      () => {},
      () => new Error('queue busy'),
    ),
  );
  assert.deepEqual(out, ['a', 'b']);
});

test('a source error before the first byte propagates, not the timeout error', async () => {
  let timedOut = false;
  const failing = (async function* () {
    await tick(10);
    throw new Error('provider exploded');
  })();
  await assert.rejects(
    collect(
      withFirstByteLimit(
        failing,
        500,
        () => {
          timedOut = true;
        },
        () => new Error('queue busy'),
      ),
    ),
    /provider exploded/,
  );
  assert.equal(timedOut, false);
});

test('an empty source ends the stream without timing out', async () => {
  const out = await collect(
    withFirstByteLimit(
      source([]),
      30,
      () => {},
      () => new Error('queue busy'),
    ),
  );
  assert.deepEqual(out, []);
});
