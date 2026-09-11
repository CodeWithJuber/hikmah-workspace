import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, compactRunMessages } from '../lib/playground/agent-runner.ts';
import { parseCheckpoint } from '../lib/playground/checkpoint.ts';
import {
  normalizeModel,
  enrichExperientialModels,
  priceKind,
  estimatedCost,
} from '../lib/playground/model-catalog.ts';
import { createCompletionBody } from '../lib/playground/transport.ts';
import { parseWorkspaceConfig, enabledSkillPrompt } from '../lib/playground/workspace-config.ts';
const tools = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
];
const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-secret',
  model: 'test/model',
  maxTokens: 4096,
  temperature: 0,
};
const result = (content = '', toolCalls = [], finishReason = 'stop') => ({
  content,
  toolCalls,
  finishReason,
  usage: { total_tokens: 10 },
  model: 'test/model',
});
const call = (id) => ({
  id: String(id),
  name: 'read_file',
  arguments: JSON.stringify({ path: 'file-' + id }),
});
const options = (extra = {}) => ({
  config,
  messages: [
    { role: 'system', content: 'Help accurately.' },
    { role: 'user', content: 'Finish the current project.' },
  ],
  tools,
  execute: async () => ({ output: 'Read result', status: 'success' }),
  execution: 'continuous',
  reviewEvery: 4,
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

test('continuous work completes after more than four requests and sixteen actions', async () => {
  let requests = 0,
    executed = 0;
  const outcome = await runAgent(
    options({
      request: async () =>
        ++requests <= 7
          ? result('', [call(requests + 'a'), call(requests + 'b'), call(requests + 'c')])
          : result('Complete'),
      execute: async () => {
        executed++;
        return { output: 'done', status: 'success' };
      },
    }),
  );
  assert.equal(outcome.status, 'complete');
  assert.equal(requests, 8);
  assert.equal(executed, 21);
  assert.equal(outcome.checkpoint.output, 'Complete');
});
test('resume after cancellation skips completed tool calls within a batch', async () => {
  const controller = new AbortController();
  let checkpoint;
  const executed = [];
  await assert.rejects(
    runAgent(
      options({
        signal: controller.signal,
        request: async () => result('', [call('a'), call('b')]),
        onCheckpoint: (cp) => {
          checkpoint = cp;
        },
        execute: async (c) => {
          executed.push(c.id);
          controller.abort();
          return { output: 'done', status: 'success' };
        },
      }),
    ),
    { name: 'AbortError' },
  );
  assert.equal(checkpoint.pendingIndex, 1);
  const restored = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
  const out = await runAgent(
    options({
      checkpoint: restored,
      request: async () => result('All done'),
      execute: async (c) => {
        executed.push(c.id);
        return { output: 'done', status: 'success' };
      },
    }),
  );
  assert.deepEqual(executed, ['a', 'b']);
  assert.equal(out.status, 'complete');
});
test('review pauses save work and a resumed run gets a new review interval', async () => {
  let n = 0;
  const base = options({
    execution: 'stepwise',
    reviewEvery: 2,
    request: async () => (++n < 4 ? result('', [call(n)]) : result('Finished')),
  });
  const paused = await runAgent(base);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.checkpoint.toolCount, 2);
  const complete = await runAgent({ ...base, checkpoint: paused.checkpoint });
  assert.equal(complete.status, 'complete');
  assert.equal(n, 4);
});
test('length-limited text continues while empty reasoning output pauses', async () => {
  let n = 0;
  const out = await runAgent(
    options({
      request: async () => (++n === 1 ? result('Part one. ', [], 'length') : result('Part two.')),
    }),
  );
  assert.equal(out.checkpoint.output, 'Part one. Part two.');
  const empty = await runAgent(options({ request: async () => result('', [], 'length') }));
  assert.equal(empty.status, 'paused');
  assert.equal(empty.checkpoint.requests, 1);
  assert.match(empty.reason, /reasoning effort/);
});
test('repeated identical actions pause before a third execution', async () => {
  let executed = 0;
  const out = await runAgent(
    options({
      request: async () => result('', [call('same')]),
      execute: async () => {
        executed++;
        return { output: 'same', status: 'success' };
      },
    }),
  );
  assert.equal(out.status, 'paused');
  assert.equal(executed, 2);
  assert.equal(out.checkpoint.phase, 'ready');
  assert.equal(out.checkpoint.pendingCalls.length, 0);
});
test('context reduction preserves the current goal and complete tool result groups', () => {
  const goal = { role: 'user', content: 'CURRENT TASK: reconcile new invoices' };
  const messages = [
    { role: 'system', content: 'Rules' },
    { role: 'user', content: 'OLD TASK' },
    ...Array.from({ length: 25 }, (_, i) => [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: String(i), type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: String(i), name: 'read_file', content: 'old'.repeat(1000) },
    ]).flat(),
    goal,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'last', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'last', name: 'read_file', content: 'latest' },
  ];
  const out = compactRunMessages(messages, 14000, goal);
  assert.equal(out.compacted, true);
  assert.ok(out.messages.some((m) => m.content === goal.content));
  assert.ok(!out.messages.some((m) => m.content === 'OLD TASK'));
  for (const m of out.messages.filter((m) => m.role === 'tool'))
    assert.ok(out.messages.some((a) => a.tool_calls?.some((c) => c.id === m.tool_call_id)));
});
test('catalog rates distinguish actual zero from missing, dynamic and route prices', () => {
  const a = normalizeModel({
    id: 'a',
    pricing: { prompt: '.000002', completion: '.000004' },
    top_provider: { max_completion_tokens: 64000 },
    context_length: 200000,
    supported_parameters: ['tools'],
  });
  assert.equal(a.pricing.input, 2);
  assert.equal(a.pricing.output, 4);
  assert.equal(a.max_output_tokens, 64000);
  assert.equal(a.tools, true);
  assert.deepEqual(normalizeModel(a), a);
  assert.equal(estimatedCost(a, 1000000, 500000), 4);
  assert.equal(
    priceKind(normalizeModel({ id: 'free', pricing: { prompt: '0', completion: '0' } })),
    'free',
  );
  for (const pricing of [
    { prompt: '-1', completion: '-1' },
    { prompt: null, completion: null },
    { basis: 'per_million', source: 'route_estimate', input: 0, output: 0 },
  ])
    assert.equal(priceKind(normalizeModel({ id: 'unknown', pricing })), 'unknown');
});
test('Experiential enrichment joins exact model and default route IDs with micro-dollar units', () => {
  const result = enrichExperientialModels([{ id: 'same' }, { id: 'other' }], {
    models: [
      {
        model: { slug: 'same', display_name: 'Named model', context_window: 128000 },
        default_provider_ids: ['route-a'],
        providers: [
          {
            id: 'route-a',
            status: 'active',
            routable: true,
            billing_source: 'host_managed',
            input_micro_usd_per_million: 2500000,
            output_micro_usd_per_million: 8000000,
            capabilities: { supports_tools: true, supported_reasoning_efforts: ['low', 'high'] },
          },
          {
            id: 'route-b',
            status: 'inactive',
            routable: true,
            billing_source: 'host_managed',
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
          },
        ],
      },
    ],
  });
  assert.equal(result[0].pricing.input, 2.5);
  assert.equal(result[0].pricing.source, 'route_estimate');
  assert.equal(result[0].context_length, 128000);
  assert.equal(estimatedCost(result[0], 100, 100), undefined);
  assert.deepEqual(result[1], { id: 'other' });
});
test('reasoning controls retain provider-returned explanation when supported', () => {
  const messages = [{ role: 'user', content: 'Solve this' }];
  const openrouter = JSON.parse(
    createCompletionBody({ ...config, reasoningEffort: 'high' }, messages),
  );
  assert.deepEqual(openrouter.reasoning, { effort: 'high', exclude: false });
  assert.equal(openrouter.reasoning_effort, undefined);
  const exp = JSON.parse(
    createCompletionBody(
      { ...config, baseUrl: 'https://api.experientiallabs.ai/v1', reasoningEffort: 'high' },
      messages,
    ),
  );
  assert.equal(exp.reasoning_effort, 'high');
  assert.equal(exp.reasoning, undefined);
});
test('imported skill bundles cannot retain credentials or executable plugin fields', () => {
  const value = parseWorkspaceConfig({
    skills: [
      {
        id: 'client',
        name: 'Client',
        description: 'Proposal',
        instructions: 'Use the approved rate card.',
        enabled: true,
        script: 'evil',
      },
    ],
    connectors: [
      {
        id: 'server',
        name: 'CRM',
        url: 'https://mcp.example/tool',
        protocol: '2025-11-25',
        approval: 'ask',
        enabled: true,
        apiKey: 'secret',
      },
    ],
    media: { imageModel: 'image', apiKey: 'secret' },
    apiKey: 'secret',
  });
  assert.ok(enabledSkillPrompt(value).includes('approved rate card'));
  assert.ok(!JSON.stringify(value).includes('secret'));
  assert.ok(!JSON.stringify(value).includes('evil'));
});

test('long continued output cannot exceed the saved message envelope', async () => {
  const { runAgent } = await import('../lib/playground/agent-runner.ts');
  const controller = new AbortController();
  let saved,
    shown = '';
  const checkpoint = {
    version: 1,
    messages: [{ role: 'user', content: 'Continue' }],
    goal: { role: 'user', content: 'Continue' },
    output: 'x'.repeat(1_999_999),
    requests: 1,
    toolCount: 0,
    compactions: 0,
    pendingCalls: [],
    pendingIndex: 0,
    recentSignatures: [],
    phase: 'ready',
  };
  await assert.rejects(
    runAgent({
      config: {},
      messages: [],
      checkpoint,
      execution: 'continuous',
      reviewEvery: 10,
      autoContinue: true,
      contextCharacters: 12000,
      signal: controller.signal,
      tools: [],
      execute: () => ({ output: '', status: 'success' }),
      onText: (x) => (shown = x),
      onProgress: () => {},
      onReceipt: () => {},
      onUsage: () => {},
      onCheckpoint: (x) => (saved = x),
      request: async (_c, _m, o) => {
        o.onText('overflow');
        throw Error('unreachable');
      },
    }),
    /display limit/,
  );
  assert.equal(shown.length, 2_000_000);
  assert.equal(saved.output.length, 2_000_000);
});
