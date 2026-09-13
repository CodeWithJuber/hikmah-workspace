// One list of providers, read by the settings screen, the relay and the
// model factory. What is asserted here is that the list is consistent with
// the three things that read it.
// Run: node --test tests/providers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  authHeaders,
  hostedProviders,
  providerFor,
  secretNameFor,
} from '../lib/ai/providers.ts';
import { RELAY_PROVIDERS, relayProviderFor } from '../lib/playground/provider-routes.ts';
import { validSecretName } from '../lib/playground/secret-reference.ts';
import { routeListingFor, withRoutePrices } from '../lib/ai/pricing.ts';

test('every preset is well-formed and reachable by the relay it is hosted on', () => {
  const ids = new Set();
  for (const provider of PROVIDERS) {
    assert.ok(!ids.has(provider.id), 'ids are unique: ' + provider.id);
    ids.add(provider.id);
    assert.match(provider.baseUrl, provider.local ? /^http:\/\/127\.0\.0\.1/ : /^https:\/\//);
    assert.equal(providerFor(provider.baseUrl + '/'), provider, 'found by its own URL');
    assert.ok(validSecretName(secretNameFor(provider.baseUrl)), 'its key has a legal name');
  }
  // The relay forwards to exactly the hosted presets, and to nothing local by name.
  assert.deepEqual(
    RELAY_PROVIDERS.map((p) => p.id).sort(),
    hostedProviders()
      .map((p) => p.id)
      .sort(),
  );
  assert.equal(relayProviderFor('http://127.0.0.1:11434/v1'), undefined);
  assert.equal(relayProviderFor('https://api.anthropic.com/v1/').id, 'anthropic');
  for (const id of ['openrouter', 'ollama', 'openai', 'anthropic', 'moonshot'])
    assert.ok(ids.has(id), id + ' is offered');
});

test('the key names keep OpenRouter’s old name and give every other provider its own', () => {
  assert.equal(secretNameFor('https://openrouter.ai/api/v1'), 'CHAT_PROVIDER_KEY');
  assert.equal(secretNameFor('https://api.anthropic.com/v1'), 'CHAT_PROVIDER_KEY_ANTHROPIC');
  assert.equal(secretNameFor('https://api.moonshot.ai/v1'), 'CHAT_PROVIDER_KEY_MOONSHOT');
  assert.equal(secretNameFor('https://my-vllm.example.com/v1'), 'CHAT_PROVIDER_KEY_CUSTOM');
});

test('a key travels the way each provider wants it', () => {
  assert.deepEqual(authHeaders('bearer', 'k'), { Authorization: 'Bearer k' });
  assert.deepEqual(authHeaders('anthropic', 'k'), {
    'x-api-key': 'k',
    'anthropic-version': '2023-06-01',
  });
  assert.deepEqual(authHeaders('none', 'k'), {});
  assert.deepEqual(authHeaders('bearer', ''), {});
});

test('a provider’s unpriced model is shown OpenRouter’s listing for the same model, as an estimate', () => {
  const price = (input, output) => ({
    basis: 'per_million',
    currency: 'USD',
    input,
    output,
    source: 'catalog',
  });
  const catalogue = [
    { id: 'anthropic/claude-sonnet-4.5', pricing: price(3, 15), context_length: 200000 },
    { id: 'openai/gpt-4.1', pricing: price(2, 8), context_length: 1047576 },
    { id: 'moonshotai/kimi-k2-0905', pricing: price(0.6, 2.5) },
    { id: 'openai/gpt-4o', pricing: price(2.5, 10) },
  ];
  assert.equal(
    routeListingFor('anthropic', 'claude-sonnet-4-5-20250929', catalogue)?.id,
    'anthropic/claude-sonnet-4.5',
  );
  assert.equal(
    routeListingFor('anthropic', 'claude-sonnet-4-5', catalogue)?.id,
    'anthropic/claude-sonnet-4.5',
  );
  assert.equal(routeListingFor('openai', 'gpt-4.1', catalogue)?.id, 'openai/gpt-4.1');
  assert.equal(routeListingFor('openai', 'gpt-4o-2024-08-06', catalogue)?.id, 'openai/gpt-4o');
  assert.equal(
    routeListingFor('moonshotai', 'kimi-k2-0905-preview', catalogue)?.id,
    'moonshotai/kimi-k2-0905',
  );
  assert.equal(routeListingFor('openai', 'gpt-99', catalogue), undefined);

  const enriched = withRoutePrices(
    [{ id: 'gpt-4.1' }, { id: 'gpt-99' }, { id: 'priced', pricing: price(1, 1) }],
    'openai',
    catalogue,
  );
  assert.equal(
    enriched[0].pricing.source,
    'route_estimate',
    'marked as an estimate, not the provider’s word',
  );
  assert.equal(enriched[0].pricing.input, 2);
  assert.equal(
    enriched[0].context_length,
    1047576,
    'the window comes along when the provider gave none',
  );
  assert.equal(enriched[1].pricing, undefined, 'no match, no invented price');
  assert.equal(enriched[2].pricing.source, 'catalog', 'a price the provider gave is kept');
});
