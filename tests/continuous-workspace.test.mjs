// What survived the browser run loop.
//
// This file used to drive `runAgent` through continuous work, resumption and
// review pauses. That loop is gone — a run belongs to the server now, and
// lib/runs covers it. What is left here is the part that was never about the
// loop: the model catalogue's pricing, the request body the transport builds,
// and what an imported skill bundle is allowed to carry.
// Run: node --test tests/continuous-workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModel,
  enrichExperientialModels,
  priceKind,
  estimatedCost,
} from '../lib/playground/model-catalog.ts';
import { createCompletionBody } from '../lib/playground/transport.ts';
import { parseWorkspaceConfig, enabledSkillPrompt } from '../lib/playground/workspace-config.ts';
const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-secret',
  model: 'test/model',
  maxTokens: 4096,
  temperature: 0,
};

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
  // An estimate is still a figure: the receipt shows it marked ≈ rather than
  // showing nothing, so a direct provider's answer is not priced as free.
  assert.equal(estimatedCost(result[0], 100, 100), 0.00105);
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
