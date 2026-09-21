import test from 'node:test';
import assert from 'node:assert/strict';
import { systemOne } from '../lib/integrations/jev-client.ts';

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
