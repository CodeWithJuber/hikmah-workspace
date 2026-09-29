import test from 'node:test';
import assert from 'node:assert/strict';
import { JEV_DEFAULT_TIMEOUT_MS, systemOne } from '../lib/integrations/jev-client.ts';

const question = { id: 'route', type: 'choice', prompt: 'Route', options: ['cheap', 'deep'] };

test('JEV adapter is fail safe when no key is configured', async () => {
  assert.equal(await systemOne({}, [question], { apiKey: '' }), null);
});

test('JEV adapter validates typed answers and uses native System One endpoint', async () => {
  let request;
  const response = await systemOne({ task: 'research' }, [question], {
    apiKey: 'test-key',
    baseUrl: 'https://typesafe.test',
    fetcher: async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          model: 'jev-1.13',
          answers: [{ id: 'route', value: 'deep', probability: 0.9 }],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(request.url, 'https://typesafe.test/v1/systemone');
  assert.equal(response.answers[0].value, 'deep');
});

test('the lane wait is bounded and short: a hung Jev fails safe to null', async () => {
  // The lane is advisory — null means the run proceeds as it would have
  // without the preflight — so a Jev that never answers must not hold the
  // run. The default is a stated constant, short enough to be a lane check
  // rather than a second provider call.
  assert.equal(JEV_DEFAULT_TIMEOUT_MS, 3_000);
  const started = Date.now();
  const result = await systemOne({ task: 'research' }, [question], {
    apiKey: 'test-key',
    timeoutMs: 40,
    // A fetch that honours the abort signal, like the real one: the abort is
    // what turns the hang into the null below.
    fetcher: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1_000, 'the abort fired on the timeout');
});
