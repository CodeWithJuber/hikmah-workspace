// Server-side endpoint policy: the SSRF boundary and the free-only guarantee.
// Run: node --test tests/ai-endpoint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EndpointError,
  allModelsFree,
  assertModelAllowed,
  isLocalEndpoint,
  isFreeOpenRouterModel,
  resolveProviderBaseUrl,
} from '../lib/ai/endpoint.ts';
import { parsePrivateAllowList } from '../lib/ai/host-policy.ts';

const none = { allowPrivate: new Set() };

test('accepts public HTTPS providers and strips the trailing slash', () => {
  assert.equal(
    resolveProviderBaseUrl('https://openrouter.ai/api/v1/', none),
    'https://openrouter.ai/api/v1',
  );
  assert.equal(
    resolveProviderBaseUrl('  https://api.example.com/v1  ', none),
    'https://api.example.com/v1',
  );
});

test('rejects the private ranges an SSRF would target', () => {
  // Cloud metadata, compose networks, and the container's own neighbours.
  for (const url of [
    'https://169.254.169.254/latest',
    'https://10.0.0.5/v1',
    'https://192.168.1.10/v1',
    'https://172.16.4.4/v1',
    'https://ollama:11434/v1',
    'https://db.internal/v1',
    'https://[fd00::1]/v1',
  ]) {
    assert.throws(() => resolveProviderBaseUrl(url, none), EndpointError, url);
  }
});

test('an operator can allow exactly the local model server they run', () => {
  const allowPrivate = parsePrivateAllowList('ollama:11434, vllm');
  assert.equal(
    resolveProviderBaseUrl('https://ollama:11434/v1', { allowPrivate }),
    'https://ollama:11434/v1',
  );
  // A bare host entry allows any port on that host.
  assert.equal(
    resolveProviderBaseUrl('https://vllm:8000/v1', { allowPrivate }),
    'https://vllm:8000/v1',
  );
  // Allowing one host does not allow its neighbours.
  assert.throws(
    () => resolveProviderBaseUrl('https://10.0.0.5/v1', { allowPrivate }),
    EndpointError,
  );
});

test('plain HTTP is allowed on loopback and on a private host the operator named', () => {
  // Ollama on the Docker host has no certificate. The name in the allow-list
  // is the operator saying this is a model server; HTTPS cannot be demanded of
  // it, and a public host still gets no such exception.
  const allowPrivate = parsePrivateAllowList('host.docker.internal');
  assert.equal(
    resolveProviderBaseUrl('http://host.docker.internal:11434/v1', { allowPrivate }),
    'http://host.docker.internal:11434/v1',
  );
  assert.throws(
    () => resolveProviderBaseUrl('http://ollama:11434/v1', { allowPrivate }),
    EndpointError,
    'a neighbour not named is still refused',
  );

  assert.equal(
    resolveProviderBaseUrl('http://127.0.0.1:11434/v1', none),
    'http://127.0.0.1:11434/v1',
  );
  assert.equal(
    resolveProviderBaseUrl('http://localhost:1234/v1', none),
    'http://localhost:1234/v1',
  );
  assert.throws(() => resolveProviderBaseUrl('http://api.example.com/v1', none), EndpointError);
});

test('rejects credentials, query strings and fragments in a base URL', () => {
  for (const url of [
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=secret',
    'https://api.example.com/v1#fragment',
  ]) {
    assert.throws(() => resolveProviderBaseUrl(url, none), EndpointError, url);
  }
});

test('rejects a missing or malformed URL', () => {
  assert.throws(() => resolveProviderBaseUrl('', none), EndpointError);
  assert.throws(() => resolveProviderBaseUrl('not a url', none), EndpointError);
});

test('free-only admits only OpenRouter free models', () => {
  assert.ok(isFreeOpenRouterModel('openrouter/free'));
  assert.ok(isFreeOpenRouterModel('meta-llama/llama-3.3-70b-instruct:free'));
  assert.ok(!isFreeOpenRouterModel('openai/gpt-4o'));

  const free = { baseUrl: 'https://openrouter.ai/api/v1', freeOnly: true };
  assert.doesNotThrow(() => assertModelAllowed({ ...free, model: 'openrouter/free' }));
  assert.doesNotThrow(() => assertModelAllowed({ ...free, model: 'qwen/qwen3-8b:free' }));
  assert.throws(() => assertModelAllowed({ ...free, model: 'openai/gpt-4o' }), EndpointError);
});

test('free-only cannot be bypassed by pointing at another endpoint', () => {
  // The whole point of the setting is that an unattended loop cannot spend
  // money, so an unrecognised endpoint is blocked rather than trusted.
  assert.throws(
    () =>
      assertModelAllowed({
        baseUrl: 'https://api.example.com/v1',
        model: 'anything:free',
        freeOnly: true,
      }),
    EndpointError,
  );
});

test('with free-only off, any resolved endpoint and model is allowed', () => {
  assert.doesNotThrow(() =>
    assertModelAllowed({ baseUrl: 'https://api.example.com/v1', model: 'openai/gpt-4o' }),
  );
});

test('free-only admits a local model server: there is nothing there to spend', () => {
  // Ollama on the box, or a vLLM the operator named. The setting exists to
  // stop an unattended loop running up a bill; a local server has none. A
  // paid hosted endpoint is still blocked, whatever the model is called.
  for (const baseUrl of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://ollama:11434/v1',
  ])
    assert.doesNotThrow(() => assertModelAllowed({ baseUrl, model: 'llama3.2', freeOnly: true }));
  assert.ok(isLocalEndpoint('http://127.0.0.1:11434/v1'));
  assert.ok(!isLocalEndpoint('https://api.example.com/v1'));
  assert.ok(!isLocalEndpoint('not a url'));
  assert.throws(
    () =>
      assertModelAllowed({
        baseUrl: 'https://api.example.com/v1',
        model: 'llama3.2',
        freeOnly: true,
      }),
    EndpointError,
  );
});

test('free-only admits Ollama Cloud whole: free within its limits, no prices to filter by', () => {
  assert.doesNotThrow(() =>
    assertModelAllowed({ baseUrl: 'https://ollama.com/v1', model: 'kimi-k3', freeOnly: true }),
  );
  assert.ok(allModelsFree('https://ollama.com/v1'));
  assert.ok(allModelsFree('http://127.0.0.1:11434/v1'));
  assert.ok(!allModelsFree('https://openrouter.ai/api/v1'));
  assert.ok(!allModelsFree('https://api.openai.com/v1'));
});
