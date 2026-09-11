import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'context-storage-'));
const db = new DatabaseSync(':memory:');
for (const file of ['drizzle/0000_heavy_star_brand.sql', 'drizzle/0001_optimal_invaders.sql'])
  db.exec(await readFile(file, 'utf8'));
const blobs = new Map();
globalThis.__contextEnv = {
  HIKMAH_OWNER_EMAIL: 'owner@example.test',
  DB: {
    prepare(sql) {
      const q = db.prepare(sql);
      let args = [];
      const statement = {
        bind(...values) {
          args = values;
          return statement;
        },
        async first() {
          return q.get(...args) ?? null;
        },
        async all() {
          return { results: q.all(...args) };
        },
        async run() {
          return { meta: { changes: Number(q.run(...args).changes) } };
        },
      };
      return statement;
    },
  },
  BUCKET: {
    async put(key, body) {
      blobs.set(key, body);
    },
    async get(key) {
      return blobs.has(key) ? { text: async () => blobs.get(key) } : null;
    },
    async delete(key) {
      blobs.delete(key);
    },
  },
};
await build({
  entryPoints: ['app/api/context-model/route.ts'],
  outfile: join(dir, 'api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'runtime',
      setup(b) {
        b.onResolve({ filter: /^@\/server\/platform\.mjs$/ }, () => ({
          path: 'env',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /^@\/app\/chatgpt-auth$/ }, () => ({
          path: 'auth',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
          contents:
            a.path === 'env'
              ? 'export const env=globalThis.__contextEnv;'
              : 'export async function getChatGPTUser(){return globalThis.__contextUser;}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(join(dir, 'api.mjs')));
const url = 'https://hikmah.test/api/context-model';
const get = (query = '') => api.GET(new Request(url + query));
const post = (body, origin = 'https://hikmah.test') =>
  api.POST(
    new Request(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const owner = () => (globalThis.__contextUser = { userId: 'owner', email: 'owner@example.test' });
test('context parameters require server owner identity and same origin', async () => {
  globalThis.__contextUser = null;
  assert.equal((await get()).status, 401);
  globalThis.__contextUser = { userId: 'other', email: 'other@example.test' };
  assert.equal((await get()).status, 403);
  owner();
  assert.equal((await get()).status, 200);
  assert.equal((await post({ action: 'reset', language: 'en' }, 'https://other.test')).status, 403);
});
test('real released parameters are saved with a recomputed gate, restored from blob, and refused activation without gain', async () => {
  owner();
  const model = JSON.parse(await readFile('public/research/v6/models/en.model.json', 'utf8'));
  const r = await post({ action: 'save', model, receipt: { approved: true } });
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.receipt.approved, false);
  assert.equal(saved.receipt.origin, 'server-recomputed');
  assert.equal(saved.receipt.sha256.length, 64);
  assert.equal(blobs.size, 1);
  const loaded = await (await get('?id=' + saved.id)).json();
  assert.deepEqual(loaded.model, model);
  assert.equal((await post({ action: 'activate', id: saved.id, language: 'en' })).status, 409);
  assert.equal((await (await get('?language=en')).json()).model, null);
});
test('stale promotion receipt cannot overwrite a newer active version', async () => {
  owner();
  const now = new Date().toISOString();
  for (const [id, parent] of [
    ['candidate-a', 'released'],
    ['candidate-b', 'released'],
  ])
    db.prepare(
      'INSERT INTO context_versions (id,user_id,language,blob_key,receipt,created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, 'owner', 'hi', id, JSON.stringify({ approved: true, basedOn: parent }), now);
  assert.equal((await post({ action: 'activate', id: 'candidate-a', language: 'hi' })).status, 200);
  assert.equal((await post({ action: 'activate', id: 'candidate-b', language: 'hi' })).status, 409);
  assert.equal(
    db.prepare('SELECT version_id FROM context_active WHERE id=?').get('owner:hi').version_id,
    'candidate-a',
  );
  assert.equal((await post({ action: 'reset', language: 'hi' })).status, 200);
});
test('uploaded malformed weights and inherited ownership cannot be used', async () => {
  owner();
  assert.equal(
    (await post({ action: 'save', model: { format: 'hikmah.context-field.v1' } })).status,
    400,
  );
  globalThis.__contextUser = { userId: 'outsider', email: 'owner@example.test' };
  assert.equal((await get()).status, 403);
  assert.equal((await post({ action: 'activate', id: 'candidate-a', language: 'hi' })).status, 403);
});
test.after(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
