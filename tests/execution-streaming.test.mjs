// What survived the browser run loop.
//
// This file used to drive `runAgent` through cancellation, checkpoint resume
// and tool continuation. That loop is gone. What remains is the streaming layer
// under it, which is still live on the server: how reasoning blocks merge, and
// what the transport reports as an answer arrives.
// Run: node --test tests/execution-streaming.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../lib/playground/transport.ts';
import { mergeReasoningDetails, publicExplanation } from '../lib/playground/reasoning.ts';
const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'fixture-key',
  model: 'requested',
  maxTokens: 1024,
  temperature: 0,
};

test('reasoning details merge by index while opaque content is retained but never displayed', () => {
  let blocks = mergeReasoningDetails(
    [],
    [
      { index: 0, type: 'reasoning.text', text: 'Check ' },
      { index: 1, type: 'reasoning.encrypted', data: 'abc' },
    ],
  );
  blocks = mergeReasoningDetails(blocks, [
    { index: 0, type: 'reasoning.text', text: 'units.' },
    { index: 1, type: 'reasoning.encrypted', data: 'def' },
  ]);
  assert.equal(publicExplanation(blocks), 'Check units.');
  assert.equal(blocks[1].data, 'abcdef');
  assert.throws(() =>
    mergeReasoningDetails(blocks, [{ index: 1, type: 'reasoning.text', text: 'changed' }]),
  );
});
test('SSE returns model identity and explanation before final answer; duplicate compatibility fields do not duplicate display', async (t) => {
  const events = [
    {
      model: 'actual-model',
      choices: [
        {
          index: 0,
          delta: {
            reasoning: 'Checking units.',
            reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'Checking units.' }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: { content: 'Answer.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 20 } },
  ];
  const encoder = new TextEncoder();
  const wire =
    events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            const b = encoder.encode(wire);
            for (let i = 0; i < b.length; i++) c.enqueue(b.slice(i, i + 1));
            c.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const seen = [];
  const result = await complete(config, [{ role: 'user', content: 'Task' }], {
    onMeta: (m) => seen.push('model:' + m.model),
    onReasoning: (s) => seen.push('explanation:' + s),
    onText: (s) => seen.push('answer:' + s),
  });
  assert.ok(seen.indexOf('model:actual-model') < seen.indexOf('answer:Answer.'));
  assert.ok(seen.includes('explanation:Checking units.'));
  assert.ok(!seen.includes('explanation:Checking units.\nChecking units.'));
  assert.equal(result.model, 'actual-model');
  assert.equal(result.usage.total_tokens, 20);
});
