// Read-only audit contribution; fixtures are synthetic, no provider credentials or network.
// Run: node --experimental-strip-types --test tests/protocol-framing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, ProviderTransportError } from '../lib/playground/transport.ts';
import { relayProviderRequest } from '../lib/server/provider-relay.ts';
const config = {
  baseUrl: 'https://api.experientiallabs.ai/v1',
  apiKey: 'test-only-key',
  model: 'test/model',
  maxTokens: 1024,
  temperature: 0.3,
};
const messages = [{ role: 'user', content: 'Hi' }];
const evt = (x) => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n';
const delta = (content, finish_reason = null, extra = {}) => ({
  model: 'test/model',
  choices: [{ index: 0, delta: { content }, finish_reason }],
  ...extra,
});
const finish = evt(delta('', 'stop')) + evt('[DONE]');
const asJson = {
  model: 'test/model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
};
function framed(body, type, size = 7) {
  const bytes = new TextEncoder().encode(body);
  let p = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (p >= bytes.length) {
          c.close();
          return;
        }
        c.enqueue(bytes.slice(p, (p += size)));
      },
    }),
    { headers: { 'Content-Type': type } },
  );
}
function relayRequest() {
  return new Request('https://unit.example/api/provider?provider=experiential&operation=chat', {
    method: 'POST',
    headers: {
      Origin: 'https://unit.example',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'X-Hikmah-Provider-Key': config.apiKey,
    },
    body: JSON.stringify({ model: config.model, messages, max_tokens: 1024, stream: true }),
  });
}
for (const [name, type, wire, expected] of [
  ['SSE under JSON MIME', 'application/json', evt(delta('Hello')) + finish, 'Hello'],
  ['JSON under SSE MIME', 'text/event-stream', JSON.stringify(asJson), 'Hello'],
  ['JSON after UTF8 BOM', 'application/json', '\uFEFF' + JSON.stringify(asJson), 'Hello'],
  [
    'SSE unknown MIME with comments',
    'text/plain',
    ': processing\r\n\r\n' + evt(delta('Hello')) + finish,
    'Hello',
  ],
])
  test(name, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => framed(wire, type, 1));
    assert.equal((await complete(config, messages)).content, expected);
  });

test('aggregate SSE overhead may exceed1MB while each event and text remain small', async (t) => {
  const wire = evt(delta('x', null, { unused_metadata: 'a'.repeat(300) })).repeat(3500) + finish;
  assert.ok(new TextEncoder().encode(wire).length > 1_000_000);
  t.mock.method(globalThis, 'fetch', async () => framed(wire, 'text/event-stream', 65536));
  assert.equal((await complete(config, messages)).content, 'x'.repeat(3500));
});

test('relay forwards large SSE without applying buffered-JSON total limit', async (t) => {
  const wire = evt(delta('x', null, { unused_metadata: 'a'.repeat(300) })).repeat(3500) + finish;
  t.mock.method(globalThis, 'fetch', async () => framed(wire, 'text/event-stream', 65536));
  const response = await relayProviderRequest(relayRequest(), true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
});

test('relay allows SSE with a generic plain-text MIME to reach format validation', async (t) => {
  const wire = evt(delta('Hello')) + finish;
  t.mock.method(globalThis, 'fetch', async () => framed(wire, 'text/plain', 7));
  const response = await relayProviderRequest(relayRequest(), true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
});

test('malformed real completion event rejects and retains preceding visible text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    framed(
      evt(delta('partial')) + 'data: {broken PRIVATE-PROMPT-ECHO ' + config.apiKey + '\n\n',
      'text/event-stream',
      7,
    ),
  );
  let text = '';
  await assert.rejects(
    complete(config, messages, { onText: (s) => (text += s) }),
    (e) =>
      e instanceof ProviderTransportError &&
      e.code === 'protocol' &&
      !e.message.includes(config.apiKey) &&
      !e.message.includes('PRIVATE-PROMPT-ECHO'),
  );
  assert.equal(text, 'partial');
});

test('valid JSON gateway error mislabeled SSE is diagnosed without displaying raw body', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    framed(
      JSON.stringify({ error: { code: 'all_routes_failed', message: config.apiKey } }),
      'text/event-stream',
      1,
    ),
  );
  await assert.rejects(
    complete(config, messages),
    (e) =>
      e instanceof ProviderTransportError &&
      e.diagnostic?.code === 'all_routes_failed' &&
      !e.message.includes(config.apiKey),
  );
});

test('buffered JSON over1MB can contain small answer plus metadata', async (t) => {
  const wire = JSON.stringify({ ...asJson, unused_metadata: 'a'.repeat(1_100_000) });
  t.mock.method(globalThis, 'fetch', async () => framed(wire, 'application/json', 65536));
  assert.equal((await complete(config, messages)).content, 'Hello');
});
