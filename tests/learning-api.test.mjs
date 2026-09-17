import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createLearningStore } from '../lib/learning/store.ts';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-learning-api-'));
const db = applySchema(new DatabaseSync(':memory:'));
globalThis.__learningApiStorage = { raw: db };
globalThis.__learningApiUser = null;
await build({
  entryPoints: ['app/api/learning/route.ts'],
  outfile: join(directory, 'api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'runtime-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'auth', namespace: 'test' }));
        builder.onResolve({ filter: /^@\/server\/storage\.mjs$/ }, () => ({
          path: 'storage',
          namespace: 'test',
        }));
        builder.onResolve({ filter: /^@\/lib\/learning\/server$/ }, () => ({
          path: 'secrets',
          namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'auth'
              ? 'export async function getChatGPTUser(){ return globalThis.__learningApiUser; }'
              : path === 'storage'
                ? 'export function getStorage(){ return globalThis.__learningApiStorage; }'
                : 'export async function learningSecrets(){ return ["server-known-fixture-key"]; }',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(join(directory, 'api.mjs')));
const url = 'https://hikmah.test/api/learning';
const get = (query = '', site) =>
  api.GET(new Request(url + query, { headers: site ? { 'Sec-Fetch-Site': site } : {} }));
const post = (body, origin = 'https://hikmah.test') =>
  api.POST(
    new Request(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
test.after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
  delete globalThis.__learningApiStorage;
  delete globalThis.__learningApiUser;
});

test('the learning API requires a real session, same-origin writes and bounded input', async () => {
  assert.equal((await get()).status, 401);
  assert.equal((await post({ action: 'configure', enabled: true })).status, 401);
  globalThis.__learningApiUser = { userId: 'owner-one' };
  assert.equal((await get('', 'cross-site')).status, 403);
  assert.equal(
    (await post({ action: 'configure', enabled: true }, 'https://attacker.test')).status,
    403,
  );
  assert.equal((await post({ action: 'configure', enabled: 'yes' })).status, 400);
  assert.equal((await post({ action: 'configure', retentionDays: 365 })).status, 400);
  assert.equal((await post({ action: 'capture', prompt: 'fake', response: 'fake' })).status, 400);
  assert.equal((await get('?limit=1000')).status, 400);
  assert.equal((await post({ action: 'review', correction: 'x'.repeat(128_001) })).status, 413);
  const response = await post({ action: 'configure', enabled: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal((await response.json()).policy.enabled, true);
});

test('the full review API keeps provenance, sanitises corrections and cannot cross tenant boundaries', async () => {
  globalThis.__learningApiUser = { userId: 'owner-one' };
  const learning = createLearningStore(db),
    runs = createRunStore(db);
  runs.createConversation({ id: 'private-chat', userId: 'owner-one' });
  runs.createRun({
    id: 'actual-run',
    conversationId: 'private-chat',
    userId: 'owner-one',
    config: { model: 'provider-model' },
  });
  runs.finish('actual-run', 'done');
  assert.equal(
    learning.capture('owner-one', 'actual-run', {
      prompt: 'Explain Java thread safety',
      response: 'Original provider answer',
      model: 'provider-model',
      provider: 'https://provider.test',
      redactions: [],
    }),
    true,
  );
  const snapshot = await (await get('?status=pending')).json(),
    id = snapshot.examples[0].id;
  globalThis.__learningApiUser = { userId: 'owner-two' };
  assert.equal((await (await get()).json()).counts.total, 0);
  assert.equal((await get('?export=all')).status, 200);
  assert.equal(await (await get('?export=all')).text(), '');
  assert.equal((await post({ action: 'review', id, revision: 0, status: 'approved' })).status, 404);
  assert.equal((await post({ action: 'delete', id })).status, 404);
  globalThis.__learningApiUser = { userId: 'owner-one' };
  const reviewed = await post({
    action: 'review',
    id,
    revision: 0,
    status: 'approved',
    correction: 'Corrected answer server-known-fixture-key',
  });
  assert.equal(reviewed.status, 200);
  const body = await reviewed.json();
  assert.equal(body.example.response, 'Original provider answer');
  assert.match(body.example.correction, /credential redacted/);
  assert.equal(body.example.runId, 'actual-run');
  assert.equal((await post({ action: 'review', id, revision: 0, status: 'rejected' })).status, 409);
  const exported = await get('?export=approved');
  assert.match(exported.headers.get('content-disposition'), /\.jsonl/);
  assert.ok(!JSON.stringify(await exported.text()).includes('server-known-fixture-key'));
  assert.equal((await post({ action: 'delete', id })).status, 200);
  assert.equal((await (await get()).json()).counts.total, 0);
});
