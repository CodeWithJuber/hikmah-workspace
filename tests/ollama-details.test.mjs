// Ollama models with their details.
//
// Ollama's OpenAI-compatible list gives ids and nothing else, so every Ollama
// model showed without a context length or its tools and thinking chips, and
// vanished under the picker's Tools filter. The details come from Ollama's own
// /api/show, one bounded request per model, kept for an hour.
// Run: node --test tests/ollama-details.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailsFromShow,
  ollamaApiFor,
  ollamaDetails,
  resetOllamaDetails,
  withOllamaDetails,
} from '../lib/server/ollama-details.ts';
import { relayProviderRequest } from '../lib/server/provider-relay.ts';
import { normalizeModel } from '../lib/playground/model-catalog.ts';

// The shape ollama.com answered for gpt-oss:20b on 2026-09-13.
const SHOW = {
  capabilities: ['completion', 'tools', 'thinking'],
  details: { parent_model: 'gpt-oss:20b', family: 'gptoss', parameter_size: '20914757184' },
  model_info: {
    'general.architecture': 'gptoss',
    'general.parameter_count': 20914757184,
    'gptoss.context_length': 131072,
  },
};

test('which endpoints are Ollama, and where its own API is', () => {
  assert.equal(ollamaApiFor('https://ollama.com/v1', []), 'https://ollama.com/api');
  assert.equal(ollamaApiFor('http://127.0.0.1:11434/v1', []), 'http://127.0.0.1:11434/api');
  // A custom server is recognised by the rows it listed.
  const local = [{ id: 'qwen3', owned_by: 'library' }];
  assert.equal(
    ollamaApiFor('http://host.docker.internal:11434/v1/', local),
    'http://host.docker.internal:11434/api',
  );
  assert.equal(ollamaApiFor('http://host.docker.internal:8000/v1', []), undefined, 'no rows');
  assert.equal(
    ollamaApiFor('http://host.docker.internal:8000/v1', [{ id: 'x', owned_by: 'vllm' }]),
    undefined,
  );
  assert.equal(ollamaApiFor('https://api.openai.com/v1', local), undefined, 'a preset that is not');
  assert.equal(ollamaApiFor('not a url', local), undefined);
});

test('a show answer is read into context, capabilities and size', () => {
  assert.deepEqual(detailsFromShow(SHOW), {
    capabilities: ['completion', 'tools', 'thinking'],
    contextLength: 131072,
    parameterSize: '20914757184',
  });
  // An architecture named under another key still yields its context length.
  assert.equal(
    detailsFromShow({ model_info: { 'llama.context_length': 8192 } }).contextLength,
    8192,
  );
  assert.equal(detailsFromShow({ error: 'model not found' }), undefined);
  assert.equal(detailsFromShow('nope'), undefined);
});

test('details land on the rows, and a listing that already knows keeps its word', () => {
  const rows = [{ id: 'gpt-oss:20b' }, { id: 'other' }, { id: 'sized', context_length: 4096 }];
  const details = new Map([
    ['gpt-oss:20b', detailsFromShow(SHOW)],
    ['sized', { capabilities: ['completion', 'vision'], contextLength: 999 }],
  ]);
  const [gpt, other, sized] = withOllamaDetails(rows, details);
  assert.deepEqual(gpt, {
    id: 'gpt-oss:20b',
    context_length: 131072,
    tools: true,
    reasoning: true,
    vision: false,
    metadata_source: 'ollama',
  });
  assert.deepEqual(other, { id: 'other' }, 'no details, no change');
  assert.equal(sized.context_length, 4096);
  assert.equal(sized.vision, true);
  assert.equal(sized.tools, false);
});

test('one show per model, a few at a time, remembered for an hour', async () => {
  resetOllamaDetails();
  const asked = [];
  let inFlight = 0;
  let peak = 0;
  const doFetch = async (url, init) => {
    asked.push(JSON.parse(init.body).model);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    assert.equal(url, 'https://ollama.com/api/show');
    assert.equal(init.method, 'POST');
    return Response.json(SHOW);
  };
  const ids = Array.from({ length: 10 }, (_, i) => 'm' + i);
  const first = await ollamaDetails('https://ollama.com/api', ids, { doFetch });
  assert.equal(first.size, 10);
  assert.equal(asked.length, 10);
  assert.ok(peak <= 6 && peak >= 2, 'a bounded few at once, got ' + peak);
  const second = await ollamaDetails('https://ollama.com/api', ids, { doFetch });
  assert.equal(second.size, 10);
  assert.equal(asked.length, 10, 'the second listing asked nothing');
  // Another server is not the same cache line.
  await ollamaDetails('http://127.0.0.1:11434/api', ['m0'], { doFetch });
  assert.equal(asked.length, 11);
});

test('a server that cannot answer leaves the rows bare, and never throws', async () => {
  resetOllamaDetails();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('refused');
  };
  const none = await ollamaDetails('http://127.0.0.1:11434/api', ['a', 'b'], { doFetch: failing });
  assert.equal(none.size, 0);
  assert.equal(calls, 2);
  // An unknown model is a 404, remembered so it is not asked again.
  const missing = async () => {
    calls += 1;
    return new Response('{"error":"model not found"}', { status: 404 });
  };
  await ollamaDetails('http://127.0.0.1:11434/api', ['gone'], { doFetch: missing });
  await ollamaDetails('http://127.0.0.1:11434/api', ['gone'], { doFetch: missing });
  assert.equal(calls, 3);
});

test('through the relay, a private Ollama lists its models with their details', async (t) => {
  resetOllamaDetails();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/v1/models'))
      return Response.json({
        data: [
          { id: 'gpt-oss:20b', object: 'model', owned_by: 'library' },
          { id: 'tiny', object: 'model', owned_by: 'library' },
        ],
      });
    assert.equal(String(url), 'http://host.docker.internal:11434/api/show');
    const { model } = JSON.parse(init.body);
    return model === 'gpt-oss:20b'
      ? Response.json(SHOW)
      : new Response('{"error":"not found"}', { status: 404 });
  });
  const previous = process.env.HIKMAH_PROVIDER_ALLOW_PRIVATE;
  process.env.HIKMAH_PROVIDER_ALLOW_PRIVATE = 'host.docker.internal';
  t.after(() => {
    if (previous === undefined) delete process.env.HIKMAH_PROVIDER_ALLOW_PRIVATE;
    else process.env.HIKMAH_PROVIDER_ALLOW_PRIVATE = previous;
  });
  const origin = 'https://playground.example.com';
  const listed = await relayProviderRequest(
    new Request(
      `${origin}/api/provider?operation=models&baseUrl=${encodeURIComponent('http://host.docker.internal:11434/v1')}`,
      { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } },
    ),
    true,
  );
  assert.equal(listed.status, 200);
  const { data } = await listed.json();
  assert.deepEqual(
    data.map((m) => m.id),
    ['gpt-oss:20b', 'tiny'],
    'every model listed, detailed or not',
  );
  assert.equal(data[0].context_length, 131072);
  assert.equal(data[0].tools, true);
  assert.equal(data[0].reasoning, true);
  assert.equal(data[1].tools, undefined, 'unknown stays unknown');
});

test('a catalogue row that takes images is marked, from either spelling', () => {
  assert.equal(normalizeModel({ id: 'a', vision: true }).vision, true);
  assert.equal(
    normalizeModel({ id: 'b', architecture: { input_modalities: ['text', 'image'] } }).vision,
    true,
  );
  assert.equal(
    normalizeModel({ id: 'c', architecture: { input_modalities: ['text'] } }).vision,
    undefined,
  );
});
