// A greeting must not spend retrieval: "Hi how are you?" once cost 18,405
// input tokens (8 memories + 3 recalled conversations) because isFillerQuery
// only knew single filler terms. lib/runs/prepare.ts's knowledgeFor is the
// real entry point, so this bundles it for real and watches the storage
// handle: a greeting returns empty without touching any store, while a real
// question reaches the stores.
// Run: node --test tests/prepare-greeting-skip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-prepare-greeting-skip-'));

// The storage handle counts every touch: prepare() and exec() are the only
// ways the knowledge, memory, recall and learning stores can read anything.
// Dummy statements answer empty, so a run that reaches them still returns
// nothing — the assertion that matters is whether they were reached at all.
globalThis.__greetSkipTouches = 0;
const dummyStatement = () => ({ all: () => [], get: () => undefined });
const rawProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'prepare' || prop === 'exec') {
        return () => {
          globalThis.__greetSkipTouches++;
          return dummyStatement();
        };
      }
      return undefined;
    },
  },
);
globalThis.__greetSkipStorage = { raw: rawProxy, BUCKET: {} };

const fixtures = {
  name: 'greeting-skip-fixtures',
  setup(builder) {
    builder.onResolve({ filter: /^@\/server\/storage\.mjs$/ }, () => ({
      path: 'storage',
      namespace: 'test',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => {
      if (path === 'storage')
        return {
          loader: 'js',
          contents: 'export function getStorage(){ return globalThis.__greetSkipStorage; }',
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
const { knowledgeFor } = await import(pathToFileURL(join(directory, 'prepare.mjs')));

const userTurn = (text) => [{ role: 'user', parts: [{ type: 'text', text }] }];

test.after(async () => {
  await rm(directory, { recursive: true, force: true });
  delete globalThis.__greetSkipStorage;
  delete globalThis.__greetSkipTouches;
});

test('a greeting yields no memories and no recalled conversations — and touches no store', async () => {
  globalThis.__greetSkipTouches = 0;
  const result = await knowledgeFor('u1', userTurn('Hi how are you?'), {
    conversationId: 'B',
    recall: true,
  });
  assert.deepEqual(result, { block: '', recall: '', used: [], conversations: [] });
  assert.equal(globalThis.__greetSkipTouches, 0, 'no store may be consulted for a greeting');
});

test('a real question still reaches the stores', async () => {
  globalThis.__greetSkipTouches = 0;
  const result = await knowledgeFor('u1', userTurn('how are you feeling about zakat'), {
    conversationId: 'B',
    recall: true,
  });
  assert.ok(globalThis.__greetSkipTouches > 0, 'retrieval must run for a real question');
  // The dummy stores hold nothing, so nothing is returned — but the path ran.
  assert.deepEqual(result.used, []);
  assert.deepEqual(result.conversations, []);
});
