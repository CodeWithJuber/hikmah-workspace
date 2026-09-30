// A greeting turn must reach the provider with zero tool definitions.
//
// Verified root cause (run_f6a3a0c9, 2026-09-30): a "Hi" run reported
// 16,864 input tokens while config.instructions was only ~1,260 tokens and
// memories/recall were correctly skipped. The ~15.6k gap was the 24 tool
// definitions (lib/ai/tools/* + MCP + catalog), sent on EVERY run — even a
// "direct" 0-call greeting. The v1 greeting fix only removed memories (~1.5k).
//
// So: when skipRetrieval() is true for the turn's query (the deterministic
// greeting/filler signal), the run is stamped toolFree at creation and the
// worker builds the agent with an empty tool set. Contract: "how are you" =>
// no tools; "how are you feeling about zakat" => tools present.
// Run: node --test tests/tool-free-greeting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRunAgent, createToolDecider } from '../lib/ai/run-agent.ts';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-tool-free-'));

// prepare.ts touches storage at import time through its module graph; stub
// the server storage handle like tests/prepare-greeting-skip.test.mjs does.
globalThis.__toolFreeStorage = { raw: new Proxy({}, { get: () => undefined }), BUCKET: {} };
const fixtures = {
  name: 'tool-free-fixtures',
  setup(builder) {
    builder.onResolve({ filter: /^@\/server\/storage\.mjs$/ }, () => ({
      path: 'storage',
      namespace: 'test',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => {
      if (path === 'storage')
        return {
          loader: 'js',
          contents: 'export function getStorage(){ return globalThis.__toolFreeStorage; }',
        };
      throw new Error('unexpected stub: ' + path);
    });
  },
};

await build({
  entryPoints: ['lib/runs/prepare.ts'],
  outfile: join(directory, 'prepare.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [fixtures],
});
const { isToolFreeTurn } = await import(pathToFileURL(join(directory, 'prepare.mjs')));

test.after(async () => {
  await rm(directory, { recursive: true, force: true });
  delete globalThis.__toolFreeStorage;
});

// --- The creation-time signal -------------------------------------------

test('isToolFreeTurn: greeting => tool-free, distinctive query => normal lane', () => {
  assert.equal(isToolFreeTurn('how are you'), true);
  assert.equal(isToolFreeTurn('Hi'), true);
  assert.equal(
    isToolFreeTurn('how are you feeling about zakat'),
    false,
    'a distinctive word must still retrieve — and keep its tools',
  );
  assert.equal(isToolFreeTurn('what is my zakat threshold'), false);
});

test('isToolFreeTurn: an explicit tool request keeps its tools even for a greeting', () => {
  assert.equal(isToolFreeTurn('hi', { webSearch: true }), false, 'Search switch wins');
  assert.equal(isToolFreeTurn('hi', { deepResearch: true }), false, 'deep research wins');
});

// --- The worker-side assembly --------------------------------------------

const provider = { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' };
const agentOptions = (extra) => ({
  provider,
  model: {},
  instructions: 'Be helpful.',
  meaningModel: {},
  signal: new AbortController().signal,
  ...extra,
});

test('createToolDecider with toolFree offers zero tools', () => {
  const { tools, safeTools } = createToolDecider(agentOptions({ toolFree: true }));
  assert.deepEqual(Object.keys(tools), [], 'no tool definitions may reach the provider');
  assert.equal(safeTools.size, 0);
});

test('createToolDecider with toolFree denies any call that somehow arrives', async () => {
  const { decide } = createToolDecider(agentOptions({ toolFree: true }));
  const decision = await decide('search_web', {});
  assert.equal(decision.gate, 'denied');
});

test('createToolDecider without toolFree offers the normal tool set', () => {
  const { tools } = createToolDecider(agentOptions({}));
  const names = Object.keys(tools);
  assert.ok(names.length > 10, `expected the full set, got ${names.length}`);
  for (const name of ['search_web', 'calculate', 'ask_user'])
    assert.ok(names.includes(name), name + ' is offered on the normal lane');
});

test('buildRunAgent with toolFree builds an agent with an empty tool set', () => {
  const agent = buildRunAgent(agentOptions({ toolFree: true }));
  assert.deepEqual(Object.keys(agent.tools ?? {}), [], 'the driven agent sends no tools');
});

test('buildRunAgent without toolFree keeps the normal tool set', () => {
  const agent = buildRunAgent(agentOptions({}));
  assert.ok(Object.keys(agent.tools ?? {}).length > 10, 'normal lane untouched');
});
