import test from 'node:test';
import assert from 'node:assert/strict';
import {
  complete,
  listModels,
  validateConfig,
  ProviderTransportError,
  TRANSPORT_LIMITS,
} from '../lib/playground/transport.ts';

const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'secret-test-key-987',
  model: 'test/model',
  maxTokens: 512,
  temperature: 0.5,
};
const messages = [{ role: 'user', content: 'Hello' }];
const encoder = new TextEncoder();
const event = (value) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const chunk = (delta, finish_reason = null, extra = {}) => ({
  choices: [{ index: 0, delta, finish_reason }],
  ...extra,
});
function stream(
  text,
  size = 7,
  headers = { 'content-type': 'text/event-stream' },
  onCancel = () => {},
) {
  const bytes = encoder.encode(text);
  let position = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (position >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(position, (position += size)));
      },
      cancel: onCancel,
    }),
    { headers },
  );
}
function json(content, extra = {}) {
  return new Response(
    JSON.stringify({
      model: 'returned/model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...extra,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
function safeError(error, code) {
  assert.ok(error instanceof ProviderTransportError);
  if (code) assert.equal(error.code, code);
  for (const text of [error.message, error.stack, JSON.stringify(error)]) {
    assert.ok(!text.includes(config.apiKey));
    assert.ok(!text.includes('PRIVATE-PROMPT-ECHO'));
  }
  return true;
}

test('config preserves custom prefixes, trims slash, permits loopback without key', () => {
  assert.equal(
    validateConfig({ ...config, baseUrl: ' https://example.com/custom/v2/// ' }).baseUrl,
    'https://example.com/custom/v2',
  );
  for (const baseUrl of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:8000/v1',
    'http://[::1]:8000/custom',
  ]) {
    assert.equal(validateConfig({ ...config, baseUrl, apiKey: '' }).baseUrl, baseUrl);
  }
  for (const baseUrl of [
    'http://example.com/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?x=y',
    'https://example.com/v1?',
    'https://example.com/v1#',
    'https://example.com/v1/chat/completions/',
    'https://example.com/v1/chat%2fcompletions',
    'https://10.0.0.1/v1',
    'https://169.254.169.254/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://device.local/v1',
  ]) {
    assert.throws(
      () => validateConfig({ ...config, baseUrl }),
      (error) => safeError(error, 'config'),
    );
  }
  for (const maxTokens of [0, 1.5, 131073, NaN])
    assert.throws(() => validateConfig({ ...config, maxTokens }), /131072/);
  assert.throws(() => validateConfig({ ...config, temperature: 2.1 }), /Temperature/);
  assert.throws(
    () => validateConfig({ ...config, baseUrl: 'http://127.example.com/v1', apiKey: '' }),
    (error) => safeError(error, 'config'),
  );
});

test('models on a custom endpoint are listed through the server, with the path preserved', async (t) => {
  // The catalogue used to be fetched by the browser itself, which works on a
  // laptop and fails on a phone: 127.0.0.1 there is the phone, and a model
  // server on the box is unreachable. The server lists it now, under the same
  // endpoint policy the run applies to the same URL.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(
      url,
      '/api/provider?operation=models&baseUrl=' +
        encodeURIComponent('https://example.com/compatible/v7'),
    );
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-Hikmah-Provider-Key'], config.apiKey);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    return new Response(
      JSON.stringify({
        data: [
          { id: 'a', name: 'Alpha', context_length: 100 },
          { id: 'a' },
          { id: 7 },
          { id: 'b', ignored: 'metadata' },
        ],
      }),
    );
  });
  assert.deepEqual(
    await listModels({ ...config, baseUrl: 'https://example.com/compatible/v7/', model: '' }),
    [{ id: 'a', name: 'Alpha', context_length: 100 }, { id: 'b' }],
  );
});

test('a model list needs no key, and a private model server may be asked for one', async (t) => {
  // OpenRouter's catalogue is public; a local server has no key at all. Both
  // were refused on the browser side before a request was even made, so the
  // picker showed one model — the connection's own — to anyone without a key
  // saved, which is everyone on their first day.
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    asked.push({ url, key: options.headers['X-Hikmah-Provider-Key'] });
    return new Response(JSON.stringify({ data: [{ id: 'llama3.2' }] }));
  });
  const base = { model: '', maxTokens: 128, temperature: 0, apiKey: '' };
  await listModels({ ...base, baseUrl: 'https://openrouter.ai/api/v1' });
  await listModels({ ...base, baseUrl: 'http://host.docker.internal:11434/v1' });
  assert.deepEqual(asked, [
    { url: '/api/provider?provider=openrouter&operation=models', key: undefined },
    {
      url:
        '/api/provider?operation=models&baseUrl=' +
        encodeURIComponent('http://host.docker.internal:11434/v1'),
      key: undefined,
    },
  ]);
  // A chat from this browser still needs a key for a hosted provider and is
  // still refused for a private host it cannot reach.
  assert.throws(
    () => validateConfig({ ...config, apiKey: '' }),
    (error) => safeError(error, 'config'),
  );
  assert.throws(
    () => validateConfig({ ...config, baseUrl: 'http://host.docker.internal:11434/v1' }),
    (error) => safeError(error, 'config'),
  );
});

test('SSE survives single-byte UTF-8/CRLF fragments and accumulates interleaved tool arguments', async (t) => {
  const events =
    ': OPENROUTER PROCESSING\r\n\r\n' +
    event(chunk({ role: 'assistant', content: 'Hello 🙂' })) +
    event(
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'call-b',
            type: 'function',
            function: { name: 'read_', arguments: '{"file":' },
          },
          {
            index: 0,
            id: 'call-a',
            type: 'function',
            function: { name: 'calc', arguments: '{"x":' },
          },
        ],
      }),
    ) +
    event(
      chunk(
        {
          tool_calls: [
            { index: 0, function: { arguments: '2}' } },
            { index: 1, function: { name: 'file', arguments: '"a.ts"}' } },
          ],
        },
        'tool_calls',
      ),
    ) +
    event(
      chunk({ content: '' }, 'tool_calls', {
        model: 'provider/model',
        usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
      }),
    ) +
    event('[DONE]');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 512);
    assert.deepEqual(payload.stream_options, { include_usage: true });
    assert.ok(!options.body.includes(config.apiKey));
    return stream(events, 1);
  });
  const text = [];
  const result = await complete(config, messages, { onText: (value) => text.push(value) });
  assert.equal(result.content, 'Hello 🙂');
  assert.deepEqual(text, ['Hello 🙂']);
  assert.deepEqual(result.toolCalls, [
    { id: 'call-a', name: 'calc', arguments: '{"x":2}' },
    { id: 'call-b', name: 'read_file', arguments: '{"file":"a.ts"}' },
  ]);
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 });
  assert.equal(result.model, 'provider/model');
});

test('JSON fallback and tools are sent once without OpenRouter usage on a custom host', async (t) => {
  let count = 0;
  const tools = [
    {
      type: 'function',
      function: {
        name: 'calc',
        parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      },
    },
  ];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    count++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream_options, undefined);
    assert.deepEqual(payload.tools, tools);
    return json(null, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'calc', arguments: '{"x":3}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { total_tokens: 9 },
    });
  });
  const result = await complete({ ...config, baseUrl: 'https://example.com/v1' }, messages, {
    tools,
  });
  assert.equal(count, 1);
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, [{ id: 'a', name: 'calc', arguments: '{"x":3}' }]);
  assert.equal(result.usage.total_tokens, 9);
});

test('sniffs missing MIME, accepts multiline data, CR separators and empty usage choices', async (t) => {
  const text =
    'event: message\rdata: {"choices": [\rdata: {"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\r' +
    event({ choices: [], usage: { total_tokens: 4 } }) +
    'data: [DONE]';
  t.mock.method(globalThis, 'fetch', async () => stream(text, 2, {}));
  const result = await complete(config, messages);
  assert.equal(result.content, 'ok');
  assert.equal(result.usage.total_tokens, 4);
});

test('completion messages preserve tool-call/result linkage without unrelated fields', async (t) => {
  const history = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'id1', type: 'function', function: { name: 'calc', arguments: '{}' } }],
      providerConfig: config,
    },
    { role: 'tool', content: '3', tool_call_id: 'id1' },
  ];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].providerConfig, undefined);
    assert.equal(body.messages[1].tool_call_id, 'id1');
    return json('3');
  });
  assert.equal((await complete(config, history)).content, '3');
});

test('HTTP, provider, parse and network failures do not expose secrets or raw prompts', async (t) => {
  const secret = `${config.apiKey} PRIVATE-PROMPT-ECHO`;
  for (const response of [
    () => new Response(JSON.stringify({ error: { message: secret } }), { status: 401 }),
    () =>
      new Response(JSON.stringify({ error: { message: secret } }), {
        headers: { 'content-type': 'application/json' },
      }),
    () => stream(event({ error: { message: secret }, choices: [] })),
    () => stream(event(`{invalid ${secret}`)),
    () => {
      throw new TypeError(secret);
    },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(complete(config, messages), (error) => safeError(error));
    mock.mock.restore();
  }
});

test('mid-stream errors reject after partial text', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async () =>
    stream(
      event(chunk({ content: 'partial' })) +
        event({
          error: { message: config.apiKey },
          choices: [{ delta: {}, finish_reason: 'error' }],
        }),
    ),
  );
  await assert.rejects(
    complete(config, messages, { onText: (value) => seen.push(value) }),
    (error) => safeError(error, 'protocol'),
  );
  assert.deepEqual(seen, ['partial']);
});

test('bounds generated content independently from stream wire bytes', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => json('x'.repeat(2_000_001)));
  await assert.rejects(complete(config, messages), (error) => safeError(error, 'limit'));
  mock.mock.restore();
});

test('pre-aborted request never calls fetch', async (t) => {
  const controller = new AbortController();
  controller.abort(config.apiKey);
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not fetch');
  });
  await assert.rejects(complete(config, messages, { signal: controller.signal }), (error) =>
    safeError(error, 'aborted'),
  );
  assert.equal(mock.mock.callCount(), 0);
});

test('abort interrupts an unresponsive body and cancels its reader', async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const response = new Response(
      new ReadableStream({
        pull() {
          queueMicrotask(() => controller.abort(config.apiKey));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    assert.ok(options.signal instanceof AbortSignal);
    return response;
  });
  await assert.rejects(complete(config, messages, { signal: controller.signal }), (error) =>
    safeError(error, 'aborted'),
  );
  assert.equal(cancelled, true);
});

test('300 second timeout aborts without waiting in tests or trusting fetch to reject', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    queueMicrotask(callback);
    return 123;
  });
  t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  await assert.rejects(complete(config, messages), (error) => safeError(error, 'timeout'));
  assert.equal(TRANSPORT_LIMITS.timeoutMs, 300_000);
});

test('rejects truncated streams and incomplete or token-limited tools', async (t) => {
  for (const text of [
    event(chunk({ content: 'partial' })),
    event(
      chunk(
        { tool_calls: [{ index: 0, function: { name: 'calc', arguments: '{}' } }] },
        'tool_calls',
      ),
    ) + event('[DONE]'),
    event(
      chunk(
        { tool_calls: [{ index: 0, id: 'a', function: { name: 'calc', arguments: '{' } }] },
        'length',
      ),
    ) + event('[DONE]'),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => stream(text));
    await assert.rejects(complete(config, messages), (error) => safeError(error));
    mock.mock.restore();
  }
});

test('DONE stops parsing and cancels unread response', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () =>
    stream(
      event(chunk({ content: 'done' }, 'stop')) +
        event('[DONE]') +
        'data: invalid trailing event\n\n',
      1,
      undefined,
      () => {
        cancelled = true;
      },
    ),
  );
  assert.equal((await complete(config, messages)).content, 'done');
  assert.equal(cancelled, true);
});
