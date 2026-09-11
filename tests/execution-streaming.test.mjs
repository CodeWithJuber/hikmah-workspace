import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, createCompletionBody } from '../lib/playground/transport.ts';
import { runAgent } from '../lib/playground/agent-runner.ts';
import { parseCheckpoint } from '../lib/playground/checkpoint.ts';
import { mergeReasoningDetails, publicExplanation } from '../lib/playground/reasoning.ts';
const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'fixture-key',
  model: 'requested',
  maxTokens: 1024,
  temperature: 0,
};
const response = (content) => ({
  content,
  toolCalls: [],
  model: 'returned',
  usage: { total_tokens: 12 },
  finishReason: 'stop',
});
const options = (extra) => ({
  config,
  messages: [{ role: 'user', content: 'Finish the task.' }],
  execute: () => ({ output: 'ok', status: 'success' }),
  execution: 'continuous',
  reviewEvery: 10,
  autoContinue: true,
  contextCharacters: 170000,
  signal: new AbortController().signal,
  onText: () => {},
  onProgress: () => {},
  onReceipt: () => {},
  onCheckpoint: () => {},
  onUsage: () => {},
  ...extra,
});
test('partial answer survives cancellation, JSON checkpoint and subsequent continuation', async () => {
  let checkpoint;
  const controller = new AbortController();
  await assert.rejects(
    runAgent(
      options({
        signal: controller.signal,
        onCheckpoint: (c) => (checkpoint = c),
        request: async (_, __, o) => {
          o.onText('Completed first paragraph. ');
          controller.abort();
          throw new DOMException('Stopped', 'AbortError');
        },
      }),
    ),
    { name: 'AbortError' },
  );
  assert.equal(checkpoint.output, 'Completed first paragraph. ');
  const restored = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
  let history;
  const result = await runAgent(
    options({
      checkpoint: restored,
      request: async (_, messages) => {
        history = messages;
        return response('Second paragraph.');
      },
    }),
  );
  assert.ok(
    history.some((m) => m.role === 'assistant' && m.content === 'Completed first paragraph. '),
  );
  assert.equal(result.checkpoint.output, 'Completed first paragraph. Second paragraph.');
});
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
test('tool continuation preserves the provider explanation and opaque signature across checkpoint normalization', async () => {
  let count = 0,
    history,
    checkpoint;
  const detail = {
    type: 'reasoning.encrypted',
    id: 'r1',
    data: 'opaque-signed-data',
    format: 'anthropic-claude-v1',
    index: 0,
  };
  await runAgent(
    options({
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      onCheckpoint: (c) => (checkpoint = c),
      request: async (_, messages) => {
        history = messages;
        return ++count === 1
          ? {
              ...response(''),
              reasoning: 'Provider text',
              reasoningDetails: [detail],
              toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }],
            }
          : response('Done');
      },
    }),
  );
  const normalized = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
  const body = JSON.parse(createCompletionBody(config, normalized.messages));
  const assistant = body.messages.find((m) => m.tool_calls);
  assert.deepEqual(assistant.reasoning_details, [detail]);
  assert.equal(assistant.reasoning, 'Provider text');
  assert.ok(history.some((m) => m.reasoning_details));
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

test('empty final replies pause instead of reporting successful completion', async () => {
  const out = await runAgent(options({ request: async () => response('') }));
  assert.equal(out.status, 'paused');
  assert.equal(out.checkpoint.phase, 'ready');
  assert.match(out.reason, /no answer text/);
});
test('tool preambles remain in history while the final deliverable stays clean', async () => {
  let n = 0,
    history;
  const out = await runAgent(
    options({
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      request: async (_, messages) => {
        history = messages;
        return ++n === 1
          ? {
              ...response('I will inspect it.'),
              toolCalls: [{ id: 't', name: 'read', arguments: '{}' }],
            }
          : response('The checked result is 42.');
      },
    }),
  );
  assert.equal(out.checkpoint.output, 'The checked result is 42.');
  assert.ok(history.some((m) => m.content === 'I will inspect it.'));
  assert.equal(out.status, 'complete');
});
