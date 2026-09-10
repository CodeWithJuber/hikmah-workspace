import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, createCompletionBody, ProviderTransportError } from '../lib/playground/transport.ts';
import { diagnoseProviderError } from '../lib/playground/provider-diagnostics.ts';
import { relayProviderRequest } from '../lib/server/provider-relay.ts';

// Synthetic credentials only. All HTTP is intercepted by each test.
const config = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'synthetic-v8-test-key', model: 'openrouter/free', maxTokens: 512, temperature: 0.3, freeOnly: true };
const messages = [{ role: 'user', content: 'Say connected.' }];
const origin = 'https://playground.example.com';
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const textEvent = content => event({ model: 'synthetic/model:free', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const success = () => new Response(textEvent('Connected') + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

test('v8 typed OpenRouter body errors take priority over a lossy generic error code', () => {
  const diagnostic = diagnoseProviderError({ error: { code: 'server_error', message: 'PRIVATE-UNTRUSTED-PROSE', metadata: { error_type: 'context_length_exceeded', raw: 'PRIVATE-UNTRUSTED-PROSE' } } }, 200);
  assert.equal(diagnostic.code, 'context_length_exceeded');
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE-UNTRUSTED-PROSE'));
});

test('v8 typed and numeric OpenRouter SSE failures retain text received before the failure', async t => {
  const cases = [
    { error: { code: 429, metadata: { error_type: 'rate_limit_exceeded' } }, expected: 'rate_limit_exceeded' },
    { error: { code: 400, metadata: { error_type: 'context_length_exceeded' } }, expected: 'context_length_exceeded' },
    { error: { code: 502, metadata: { error_type: 'provider_unavailable' } }, expected: 'provider_unavailable' },
    { error: { code: 429 }, expected: 'rate_limit_exceeded' },
    { error: { code: 401 }, expected: 'invalid_key' },
  ];
  for (const { error, expected } of cases) {
    let partial = '';
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(textEvent('Saved partial text. ') + event({ error: { ...error, message: 'PRIVATE-UNTRUSTED-PROSE' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(complete(config, messages, { onText: delta => { partial += delta; } }), error => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.diagnostic?.code, expected);
      assert.ok(!JSON.stringify(error).includes('PRIVATE-UNTRUSTED-PROSE'));
      return true;
    });
    assert.equal(partial, 'Saved partial text. ');
    assert.equal(mock.mock.callCount(), 1, 'generation must not silently retry');
    mock.mock.restore();
  }
});

test('v8 choice-level typed errors also preserve an earlier streamed answer', async t => {
  const deltas = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(textEvent('First fragment') + event({ choices: [{ index: 0, delta: {}, finish_reason: 'error', error: { code: 400, metadata: { error_type: 'context_length_exceeded' } } }] }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(complete(config, messages, { onText: value => deltas.push(value) }), error => error.diagnostic?.code === 'context_length_exceeded');
  assert.deepEqual(deltas, ['First fragment']);
});

test('v8 free-only rejects paid models and alternate providers before a network request', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw Error('No provider call is allowed for a rejected free-only configuration.'); });
  const rejected = [
    { model: 'vendor/paid-model' },
    { model: 'openrouter/auto' },
    { model: 'vendor/model:free:online' },
    { model: 'vendor/model:online:free' },
    { model: 'openrouter/free:online' },
    { baseUrl: 'https://api.experientiallabs.ai/v1' },
    { baseUrl: 'https://custom-provider.example/v1' },
    { baseUrl: 'https://openrouter.ai/api/v2' },
    { baseUrl: 'https://openrouter.ai.evil.example/api/v1' },
  ];
  for (const patch of rejected) await assert.rejects(complete({ ...config, ...patch }, messages), error => error instanceof ProviderTransportError);
  assert.equal(mock.mock.callCount(), 0);
});

test('v8 every explicitly free generation has zero input output and request price ceilings', () => {
  for (const model of ['openrouter/free', 'synthetic/model:free']) {
    const payload = JSON.parse(createCompletionBody({ ...config, model }, messages));
    assert.equal(payload.model, model);
    assert.deepEqual(payload.provider?.max_price, { prompt: 0, completion: 0, request: 0 });
    assert.equal(payload.plugins, undefined);
    assert.equal(payload.models, undefined, 'no hidden paid model fallback');
  }
  const ordinary = JSON.parse(createCompletionBody({ ...config, freeOnly: undefined, model: 'synthetic/paid-model' }, messages));
  assert.equal(ordinary.model, 'synthetic/paid-model', 'legacy callers retain normal behavior when policy was not requested');
});

test('v8 browser relay roundtrip preserves free-only restrictions at the upstream request', async t => {
  let relayed = 0;
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (typeof url === 'string' && url.startsWith('/api/provider')) {
      relayed++;
      const incoming = new Request(new URL(url, origin), { ...options, headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
      return relayProviderRequest(incoming, true);
    }
    upstream++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.equal(options.headers['X-Hikmah-Provider-Key'], undefined);
    assert.equal(options.headers['X-Hikmah-Free-Only'], undefined);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'openrouter/free');
    assert.deepEqual(payload.provider?.max_price, { prompt: 0, completion: 0, request: 0 });
    assert.equal(payload.plugins, undefined);
    return success();
  });
  const result = await complete(config, messages);
  assert.equal(result.content, 'Connected');
  assert.equal(relayed, 1);
  assert.equal(upstream, 1);
});

test('v8 relay retains typed upstream diagnostics without forwarding error prose', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (typeof url === 'string' && url.startsWith('/api/provider')) return relayProviderRequest(new Request(new URL(url, origin), { ...options, headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' } }), true);
    return Response.json({ error: { code: 400, message: 'PRIVATE-UNTRUSTED-PROSE', metadata: { error_type: 'context_length_exceeded' } } }, { status: 400 });
  });
  await assert.rejects(complete(config, messages), error => {
    assert.equal(error.diagnostic?.code, 'context_length_exceeded');
    assert.ok(!JSON.stringify(error).includes('PRIVATE-UNTRUSTED-PROSE'));
    return true;
  });
});

test('v8 direct relay rejects paid models when either the free-only header or zero caps request free routing', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw Error('A rejected relay request must never reach an upstream provider.'); });
  const payload = { model: 'synthetic/paid-model', stream: true, max_tokens: 512, messages };
  for (const useHeader of [true, false]) {
    const response = await relayProviderRequest(new Request(`${origin}/api/provider?provider=openrouter&operation=chat`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hikmah-Provider-Key': config.apiKey, ...(useHeader ? { 'X-Hikmah-Free-Only': 'true' } : {}) },
      body: JSON.stringify({ ...payload, ...(!useHeader ? { provider: { max_price: { prompt: 0, completion: 0, request: 0 } } } : {}) }),
    }), true);
    assert.equal(response.status, 400);
  }
  assert.equal(mock.mock.callCount(), 0);
});

test('v8 relay recognizes zero-price policy without depending on the browser header', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).provider?.max_price, { prompt: 0, completion: 0, request: 0 });
    return success();
  });
  const response = await relayProviderRequest(new Request(`${origin}/api/provider?provider=openrouter&operation=chat`, {
    method: 'POST',
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hikmah-Provider-Key': config.apiKey },
    body: createCompletionBody(config, messages),
  }), true);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Connected/);
  assert.equal(mock.mock.callCount(), 1);
});
