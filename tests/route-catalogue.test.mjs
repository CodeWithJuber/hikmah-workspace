// OpenRouter's public listing, fetched once an hour and shared.
// Run: node --test tests/route-catalogue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRouteCatalogue, routeCatalogue } from '../lib/server/route-catalogue.ts';

const listing = () =>
  Response.json({
    data: [{ id: 'openai/gpt-4.1', pricing: { prompt: '0.000002', completion: '0.000008' } }],
  });

test('one fetch serves every caller within the hour, and a failure keeps the last good listing', async (t) => {
  t.after(resetRouteCatalogue);
  resetRouteCatalogue();
  let calls = 0;
  let clock = 0;
  const doFetch = async () => {
    calls += 1;
    if (calls === 2) return new Response('down', { status: 503 });
    return listing();
  };
  const now = () => clock;
  const [a, b] = await Promise.all([
    routeCatalogue(undefined, doFetch, now),
    routeCatalogue(undefined, doFetch, now),
  ]);
  assert.equal(calls, 1, 'concurrent callers share one fetch');
  assert.equal(a[0].id, 'openai/gpt-4.1');
  assert.equal(a[0].pricing.input, 2);
  assert.equal(b, a);
  clock = 30 * 60 * 1000;
  await routeCatalogue(undefined, doFetch, now);
  assert.equal(calls, 1, 'half an hour later it is still fresh');
  clock = 61 * 60 * 1000;
  const stale = await routeCatalogue(undefined, doFetch, now);
  assert.equal(calls, 2, 'after an hour it is asked again');
  assert.equal(stale[0].id, 'openai/gpt-4.1', 'and a failed refresh keeps the last listing');
});

test('with nothing cached, a failure is a failure', async (t) => {
  t.after(resetRouteCatalogue);
  resetRouteCatalogue();
  await assert.rejects(routeCatalogue(undefined, async () => new Response('x', { status: 500 })));
});
