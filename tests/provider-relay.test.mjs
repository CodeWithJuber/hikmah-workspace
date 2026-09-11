import test from 'node:test';
import assert from 'node:assert/strict';
import { relayProviderFor } from '../lib/playground/provider-routes.ts';
import { relayProviderRequest } from '../lib/server/provider-relay.ts';
import { complete, listModels } from '../lib/playground/transport.ts';

const origin = 'https://playground.example.com';
const key = 'test-only-private-key';
const encoder = new TextEncoder();
const payload = {
  model: 'example/model',
  max_tokens: 128,
  temperature: 0,
  stream: true,
  messages: [{ role: 'user', content: 'PRIVATE-PROMPT' }],
};
function request({
  provider = 'experiential',
  operation = 'chat',
  method,
  body,
  headers = {},
  signal,
} = {}) {
  const verb = method ?? (operation === 'chat' ? 'POST' : 'GET');
  return new Request(
    `${origin}/api/provider?provider=${encodeURIComponent(provider)}&operation=${operation}`,
    {
      method: verb,
      signal,
      headers: {
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-Hikmah-Provider-Key': key,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(verb === 'POST' ? { body: body ?? JSON.stringify(payload) } : {}),
    },
  );
}
function completionStream(text = 'Hello') {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('relay selection recognizes only exact configured origins and paths', () => {
  assert.equal(relayProviderFor(' https://api.experientiallabs.ai/v1/// ').id, 'experiential');
  assert.equal(relayProviderFor('https://OPENROUTER.ai:443/api/v1').id, 'openrouter');
  for (const url of [
    'https://api.experientiallabs.ai.evil.com/v1',
    'https://api.experientiallabs.ai:8443/v1',
    'http://api.experientiallabs.ai/v1',
    'https://api.experientiallabs.ai/v2',
    'https://api.experientiallabs.ai/v1?url=http://localhost',
    'https://user:pass@api.experientiallabs.ai/v1',
    'http://localhost:11434/v1',
  ])
    assert.equal(relayProviderFor(url), undefined);
});

test('browser routes Experiential Labs and OpenRouter through authenticated same-origin requests', async (t) => {
  for (const [baseUrl, provider] of [
    ['https://api.experientiallabs.ai/v1', 'experiential'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, `/api/provider?provider=${provider}&operation=chat`);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.headers['X-Hikmah-Provider-Key'], key);
      assert.equal(options.headers.Authorization, undefined); // Do not interfere with Site auth.
      assert.ok(!options.body.includes(key));
      return completionStream();
    });
    assert.equal(
      (
        await complete(
          { baseUrl, apiKey: key, model: payload.model, maxTokens: 128, temperature: 0 },
          payload.messages,
        )
      ).content,
      'Hello',
    );
    mock.mock.restore();
  }
});

test('authentication and same-origin enforcement happen before any upstream call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('must not fetch');
  });
  assert.equal(
    (await relayProviderRequest(request(), false)).headers.get('X-Hikmah-Relay-Error'),
    'session',
  );
  for (const headers of [
    { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null' },
  ]) {
    assert.equal(
      (await relayProviderRequest(request({ headers }), true)).headers.get('X-Hikmah-Relay-Error'),
      'origin',
    );
  }
  const absent = request();
  absent.headers.delete('origin');
  absent.headers.delete('sec-fetch-site');
  assert.equal((await relayProviderRequest(absent, true)).status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('relay refuses arbitrary destinations, paths, methods and missing keys', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('must not fetch');
  });
  for (const options of [
    { provider: 'https://169.254.169.254' },
    { provider: 'constructor' },
    { operation: '../key' },
    { operation: 'models', method: 'POST' },
    { headers: { 'X-Hikmah-Provider-Key': '' } },
    { headers: { 'Content-Type': 'text/plain' } },
  ]) {
    assert.equal((await relayProviderRequest(request(options), true)).status, 400);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('actual browser-to-relay-to-provider streaming works without provider CORS headers', async (t) => {
  const upstreamCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('/api/provider')) {
      const req = new Request(new URL(url, origin), {
        ...options,
        headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      });
      return relayProviderRequest(req, true);
    }
    upstreamCalls.push({ url, options });
    assert.equal(url, 'https://api.experientiallabs.ai/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.headers['X-Hikmah-Provider-Key'], undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    assert.equal(body.stream_options, undefined);
    assert.deepEqual(body.messages, payload.messages);
    return completionStream('Salaam 🙂');
  });
  const deltas = [];
  const result = await complete(
    {
      baseUrl: 'https://api.experientiallabs.ai/v1',
      apiKey: key,
      model: payload.model,
      maxTokens: 128,
      temperature: 0,
    },
    payload.messages,
    { onText: (text) => deltas.push(text) },
  );
  assert.equal(result.content, 'Salaam 🙂');
  assert.deepEqual(deltas, ['Salaam 🙂']);
  assert.equal(upstreamCalls.length, 1);
});

test('model loading remains usable if public metadata enrichment is unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('/api/provider'))
      return relayProviderRequest(
        new Request(new URL(url, origin), {
          ...options,
          headers: { ...options.headers, 'Sec-Fetch-Site': 'same-origin' },
        }),
        true,
      );
    if (url === 'https://api.experientiallabs.ai/api/models?limit=1000') {
      assert.equal(options.headers?.Authorization, undefined);
      return new Response('Unavailable', { status: 503 });
    }
    assert.equal(url, 'https://api.experientiallabs.ai/v1/models');
    assert.equal(options.method, 'GET');
    return Response.json({
      data: [
        { id: 'a', name: 'Model A', context_length: 8192, description: 'x'.repeat(1_100_000) },
      ],
    });
  });
  assert.deepEqual(
    await listModels({
      baseUrl: 'https://api.experientiallabs.ai/v1',
      apiKey: key,
      model: '',
      maxTokens: 128,
      temperature: 0,
    }),
    [{ id: 'a', name: 'Model A', context_length: 8192 }],
  );
});

test('server revalidates message, token and tool limits and strips extra request controls', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.n, undefined);
    assert.equal(body.baseUrl, undefined);
    assert.equal(body.messages[0].providerConfig, undefined);
    assert.equal(body.tools[0].function.name, 'calculate');
    return completionStream();
  });
  const invalid = [
    { ...payload, max_tokens: 131073 },
    { ...payload, messages: [] },
    { ...payload, messages: [{ role: 'admin', content: 'x' }] },
    { ...payload, tools: [{ type: 'shell' }] },
    { ...payload, stream: 'invalid' },
  ];
  for (const body of invalid)
    assert.equal(
      (await relayProviderRequest(request({ body: JSON.stringify(body) }), true)).status,
      400,
    );
  assert.equal(mock.mock.callCount(), 0);
  const response = await relayProviderRequest(
    request({
      body: JSON.stringify({
        ...payload,
        n: 100,
        baseUrl: 'http://localhost',
        messages: [{ ...payload.messages[0], providerConfig: { key } }],
        tools: [
          { type: 'function', function: { name: 'calculate', parameters: { type: 'object' } } },
        ],
      }),
    }),
    true,
  );
  assert.equal(response.status, 200);
  await response.text();
});

test('upstream failures preserve status without echoing credentials or prompts and never retry', async (t) => {
  for (const status of [401, 402, 403, 404, 429, 503]) {
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(`${key} PRIVATE-PROMPT`, { status }),
    );
    const response = await relayProviderRequest(request(), true);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    const text = await response.text();
    assert.ok(!text.includes(key) && !text.includes('PRIVATE-PROMPT'));
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('redirect and HTML responses are not followed or treated as a connection success', async (t) => {
  for (const factory of [
    () => new Response('', { status: 302, headers: { Location: 'http://localhost' } }),
    () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => factory());
    const response = await relayProviderRequest(request(), true);
    assert.equal(response.headers.get('X-Hikmah-Relay-Error'), 'protocol');
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('bounded request reading rejects malformed JSON and oversized streamed bodies', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('must not fetch');
  });
  assert.equal((await relayProviderRequest(request({ body: '{invalid' }), true)).status, 400);
  assert.equal(
    (await relayProviderRequest(request({ body: 'x'.repeat(4_000_001) }), true)).status,
    413,
  );
  assert.equal(mock.mock.callCount(), 0);
});

test('chat wire streams are forwarded without an aggregate byte cap', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(': metadata ' + 'x'.repeat(1_100_000) + '\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  const response = await relayProviderRequest(request(), true);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).length > 1_000_000);
});

test('caller cancellation aborts the upstream stream and cancels its reader', async (t) => {
  let signal,
    cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(encoder.encode(': waiting\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const response = await relayProviderRequest(request(), true);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('timeout ends an unresponsive upstream request without retries', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    queueMicrotask(callback);
    return 1;
  });
  t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  const response = await relayProviderRequest(request({ operation: 'models' }), true);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('X-Hikmah-Relay-Error'), 'timeout');
});

test('relay sign-in failures are distinguished from an invalid provider key in the browser', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('{}', { status: 401, headers: { 'X-Hikmah-Relay-Error': 'session' } }),
  );
  await assert.rejects(
    complete(
      {
        baseUrl: 'https://api.experientiallabs.ai/v1',
        apiKey: key,
        model: payload.model,
        maxTokens: 128,
        temperature: 0,
      },
      payload.messages,
    ),
    /sign-in has expired/,
  );
});
