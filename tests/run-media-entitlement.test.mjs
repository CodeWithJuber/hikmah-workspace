// "Image and speech generation", which the Pro plan sells and every tier had.
//
// The media key was derived from the run's own provider key whenever the run
// was on OpenRouter, so a free bring-your-own-key user got generate_image and
// generate_speech for nothing — the plan's paid feature was quietly everyone's.
//
// Measured by building the real agent at each tier and reading its tool map,
// not by describing the gate.
// Run: node --test tests/run-media-entitlement.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRunAgent } from '../lib/ai/run-agent.ts';
import { mediaKeyFor } from '../lib/runs/media.ts';

// entitlements.ts reaches the plan catalogue, which imports through the `@/`
// alias node cannot resolve, so it is bundled the way tests/billing-access does.
const dir = await mkdtemp(join(tmpdir(), 'hikmah-media-'));
await build({
  entryPoints: ['lib/billing/entitlements.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { entitlementsFor } = await import(pathToFileURL(join(dir, 'entitlements.mjs')));

const OPENROUTER = 'https://openrouter.ai/api/v1';

/** The run config the route writes for someone on this tier, in the two fields
 * the media decision reads. */
const configFor = (tier) => ({
  media: entitlementsFor(tier).media,
  baseUrl: OPENROUTER,
  apiKey: 'their-own-openrouter-key',
});

/** The real agent, built the way lib/runs/service.ts builds it. */
function toolsFor(tier, env = {}) {
  const agent = buildRunAgent({
    provider: { baseUrl: OPENROUTER, model: 'a/b:free', apiKey: 'k' },
    model: {},
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
    media: {
      userId: 'u1',
      assets: { put: async () => {}, get: async () => null },
      key: mediaKeyFor(configFor(tier), env),
    },
  });
  return new Set(Object.keys(agent.tools));
}

test('a free bring-your-own-key run is not offered pictures and speech', () => {
  // Fails against the old derivation, which handed them their own key.
  const tools = toolsFor('byok');
  assert.equal(tools.has('generate_image'), false);
  assert.equal(tools.has('generate_speech'), false);
  // And the run is otherwise whole: this removes two tools, not a tier.
  assert.ok(tools.has('run_javascript'), 'everything else it had, it still has');
});

test('the paid tiers get what the plan says they get', () => {
  for (const tier of ['managed', 'owner']) {
    const tools = toolsFor(tier);
    assert.ok(tools.has('generate_image'), tier + ' generates pictures');
    assert.ok(tools.has('generate_speech'), tier + ' generates speech');
  }
});

test('a run written before the entitlement existed keeps both tools', () => {
  // No `media` field at all, which is every row already in the database.
  assert.equal(mediaKeyFor({ baseUrl: OPENROUTER, apiKey: 'k' }), 'k');
});

test('off the provider that hosts media, the deployment key decides — and the plan still gates it', () => {
  const elsewhere = { baseUrl: 'https://api.example.test/v1', apiKey: 'their-key' };
  // Never their own key: it is not a key for the service that would run this.
  assert.equal(mediaKeyFor({ ...elsewhere, media: true }, {}), '');
  assert.equal(mediaKeyFor({ ...elsewhere, media: true }, { HIKMAH_MEDIA_KEY: 'ops' }), 'ops');
  // And the plan is checked first: a deployment key does not buy a free user
  // the paid feature.
  assert.equal(mediaKeyFor({ ...elsewhere, media: false }, { HIKMAH_MEDIA_KEY: 'ops' }), '');
});
