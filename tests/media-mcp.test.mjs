import test from 'node:test';
import assert from 'node:assert/strict';
import { relayMediaRequest } from '../lib/server/media-relay.ts';
import {
  parseMediaImages,
  parseVideoJob,
  parseTranscription,
} from '../lib/playground/media-client.ts';
import { connectMcp, callMcp, validateMcpUrl } from '../lib/playground/mcp-client.ts';
const origin = 'https://playground.example.com',
  key = 'not-a-real-key';
function request(operation, body, extra = {}) {
  return new Request(origin + '/api/media?operation=' + operation, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Hikmah-Provider-Key': key,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test('media authentication and operation validation reject before fetching', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('No network expected');
  });
  assert.equal((await relayMediaRequest(request('models&kind=image'), false)).status, 401);
  assert.equal(
    (
      await relayMediaRequest(
        request('models&kind=image', undefined, { Origin: 'https://evil.example' }),
        true,
      )
    ).status,
    403,
  );
  assert.equal((await relayMediaRequest(request('video_content&job=../secret'), true)).status, 400);
  assert.equal((await relayMediaRequest(request('anything', { model: 'x' }), true)).status, 400);
  assert.equal(mock.mock.callCount(), 0);
});
test('speech sends its own key and returns audio without JSON wrapping', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'speech/model',
      input: 'Hello',
      voice: 'voice-a',
      response_format: 'mp3',
    });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const response = await relayMediaRequest(
    request('speech', {
      model: 'speech/model',
      prompt: 'Hello',
      voice: 'voice-a',
      untrusted_url: 'https://evil.example',
    }),
    true,
  );
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.equal(mock.mock.callCount(), 1);
});
test('image generation and transcription use distinct native schemas', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/images')) {
      assert.deepEqual(body, { model: 'image/model', prompt: 'A tree' });
      return Response.json({ data: [{ b64_json: 'AQID', media_type: 'image/png' }] });
    }
    assert.ok(url.endsWith('/audio/transcriptions'));
    assert.deepEqual(body, {
      model: 'stt/model',
      input_audio: { data: 'AQID', format: 'wav' },
      response_format: 'json',
    });
    return Response.json({ text: 'Hello there' });
  });
  const image = await relayMediaRequest(
    request('image', { model: 'image/model', prompt: 'A tree' }),
    true,
  );
  assert.equal(parseMediaImages(await image.json())[0].media_type, 'image/png');
  const speech = await relayMediaRequest(
    request('transcribe', { model: 'stt/model', input_audio: { data: 'AQID', format: 'wav' } }),
    true,
  );
  assert.equal(parseTranscription(await speech.json()), 'Hello there');
  assert.equal(mock.mock.callCount(), 2);
});
test('saved video retrieval cannot submit another generation or follow a returned URL', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST')
      return Response.json(
        { id: 'job-123', status: 'pending', polling_url: 'http://localhost/secrets' },
        { status: 202 },
      );
    if (url.endsWith('/content?index=0'))
      return new Response(new Uint8Array([4, 5]), { headers: { 'Content-Type': 'video/mp4' } });
    return Response.json({
      id: 'job-123',
      status: 'completed',
      unsigned_urls: ['http://localhost/secrets'],
    });
  });
  const submit = await relayMediaRequest(
    request('video', { model: 'video/model', prompt: 'A waving tree' }),
    true,
  );
  assert.deepEqual(parseVideoJob(await submit.json()), { id: 'job-123', status: 'pending' });
  const poll = await relayMediaRequest(request('video_status&job=job-123'), true);
  assert.equal((await poll.json()).status, 'completed');
  const file = await relayMediaRequest(request('video_content&job=job-123'), true);
  await file.arrayBuffer();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(calls.every((c) => c.url.startsWith('https://openrouter.ai/api/v1/videos')));
});
test('media failures do not retry or disclose a provider echo of credentials', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { message: key + ' private prompt', code: 'upstream_error' } },
      { status: 500 },
    ),
  );
  const result = await relayMediaRequest(
    request('image', { model: 'm', prompt: 'private prompt' }),
    true,
  );
  const body = await result.text();
  assert.ok(!body.includes(key));
  assert.ok(!body.includes('private prompt'));
  assert.equal(mock.mock.callCount(), 1);
});
test('MCP rejects embedded credentials and arbitrary insecure network destinations', () => {
  for (const value of [
    'https://key:password@example.com/mcp',
    'https://example.com/mcp?key=x',
    'http://example.com/mcp',
    'file:///etc/passwd',
  ])
    assert.throws(() => validateMcpUrl(value));
  assert.equal(validateMcpUrl('http://localhost:7777/mcp'), 'http://localhost:7777/mcp');
});
test('legacy MCP initializes, preserves its own session, paginates and calls an exact tool', async (t) => {
  const seen = [];
  const connection = { id: 'legacy-test', url: 'https://mcp.example/rpc', protocol: '2025-11-25' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, connection.url);
    assert.equal(options.headers.Authorization, 'Bearer connector-only');
    assert.equal(options.credentials, 'omit');
    const body = JSON.parse(options.body);
    seen.push(body.method);
    let result;
    if (body.method === 'initialize')
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else {
      assert.equal(options.headers['Mcp-Session-Id'], 'session-1');
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list')
        result = body.params.cursor
          ? { tools: [{ name: 'two', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'next' };
      else {
        assert.equal(body.params.name, 'two');
        result = { content: [{ type: 'text', text: 'Actual result' }] };
      }
    }
    return Response.json(
      { jsonrpc: '2.0', id: body.id, result },
      { headers: { 'Mcp-Session-Id': 'session-1' } },
    );
  });
  const tools = await connectMcp(connection, 'connector-only');
  assert.deepEqual(
    tools.map((x) => x.name),
    ['one', 'two'],
  );
  assert.equal(
    (await callMcp(connection, 'connector-only', tools[1], {})).content[0].text,
    'Actual result',
  );
  assert.deepEqual(seen, [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/list',
    'tools/call',
  ]);
});
test('current MCP supports stateless headers and SSE tool results', async (t) => {
  const connection = { id: 'modern-test', url: 'https://mcp.example/rpc', protocol: '2026-07-28' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.notEqual(body.method, 'initialize');
    assert.equal(options.headers['Mcp-Method'], body.method);
    assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    if (body.method === 'tools/list')
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'query', inputSchema: { type: 'object' } }] },
      });
    assert.equal(options.headers['Mcp-Name'], 'query');
    return new Response(
      'data: ' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { resultType: 'complete', content: [{ type: 'text', text: 'Done' }] },
        }) +
        '\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const tools = await connectMcp(connection, '');
  assert.equal((await callMcp(connection, '', tools[0], {})).content[0].text, 'Done');
  assert.equal(calls, 2);
});
