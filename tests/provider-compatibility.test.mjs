import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompletionBody,
  complete,
  ProviderTransportError,
} from '../lib/playground/transport.ts';
import { diagnoseProviderError } from '../lib/playground/provider-diagnostics.ts';
const config = {
  baseUrl: 'https://api.experientiallabs.ai/v1',
  apiKey: 'secret-key-for-test',
  model: 'test-model',
  temperature: 0.3,
  maxTokens: 512,
};
const messages = [{ role: 'user', content: 'hello' }];
test('existing saved temperatures do not imply opt-in sampling', () => {
  const payload = JSON.parse(createCompletionBody(config, messages));
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.max_tokens, 512);
  assert.equal(payload.stream, true);
  assert.equal(payload.stream_options, undefined);
});
test('advanced sampling, non-streaming and token field preferences are honored explicitly', () => {
  const payload = JSON.parse(
    createCompletionBody(
      { ...config, customSampling: true, stream: false, tokenParameter: 'max_completion_tokens' },
      messages,
    ),
  );
  assert.equal(payload.temperature, 0.3);
  assert.equal(payload.max_completion_tokens, 512);
  assert.equal(payload.max_tokens, undefined);
  assert.equal(payload.stream, false);
});
test('SSE routing errors carry a useful stable code without provider prose', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            error: { code: 'all_routes_failed', message: config.apiKey + ' PRIVATE-PROMPT-ECHO' },
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  await assert.rejects(
    complete(config, messages),
    (e) =>
      e instanceof ProviderTransportError &&
      e.diagnostic.code === 'all_routes_failed' &&
      e.diagnostic.action.includes('sampling off') &&
      !JSON.stringify(e).includes(config.apiKey),
  );
});
test('parameter failures preserve only known parameter names', () => {
  const d = diagnoseProviderError(
    { error: { code: 'unsupported_parameter', param: 'temperature', message: 'secret' } },
    400,
  );
  assert.equal(d.parameter, 'temperature');
  assert.ok(d.action.includes('sampling'));
  assert.equal(
    diagnoseProviderError({ error: { code: 'secret', param: 'secret', message: 'secret' } })
      .parameter,
    undefined,
  );
});
test('false and empty error metadata do not reject valid successful responses', async (t) => {
  for (const error of [null, false, '', {}]) {
    const m = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({
        error,
        choices: [{ message: { content: 'Connected' }, finish_reason: 'stop' }],
      }),
    );
    assert.equal((await complete(config, messages)).content, 'Connected');
    m.mock.restore();
  }
});
// Two tests lived here about how a browser-held transcript was folded into a
// request: contextMessages and entryText, from lib/playground/chat-context. The
// transcript is rows on the server now and the folding is lib/ai/context, which
// tests/ai-context covers — so they went with the module.
