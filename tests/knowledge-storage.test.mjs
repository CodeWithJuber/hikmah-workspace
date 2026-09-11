import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const cwd = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'v7-storage-audit-'));
const db = new DatabaseSync(':memory:');
db.exec(await readFile(cwd + '/drizzle/0000_heavy_star_brand.sql', 'utf8'));
const blobs = new Map();
let failPut = false;
let commitThenThrow = false;
const bucket = {
  async put(key, body) {
    if (failPut) throw Error('fixture storage failure');
    blobs.set(key, body);
  },
  async get(key) {
    return blobs.has(key) ? { text: async () => blobs.get(key) } : null;
  },
  async delete(key) {
    blobs.delete(key);
  },
};
globalThis.__v7Env = {
  DB: {
    prepare(sql) {
      const q = db.prepare(sql);
      let args = [];
      const s = {
        bind(...v) {
          args = v;
          return s;
        },
        async first() {
          return q.get(...args) ?? null;
        },
        async all() {
          return { results: q.all(...args) };
        },
        async run() {
          const result = q.run(...args);
          if (commitThenThrow && sql.startsWith('UPDATE workspace_states')) {
            commitThenThrow = false;
            throw Error('fixture lost database commit acknowledgment');
          }
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return s;
    },
  },
  BUCKET: bucket,
};
await build({
  absWorkingDir: cwd,
  entryPoints: ['app/api/workspace-state/route.ts'],
  outfile: join(dir, 'api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'fixture',
      setup(b) {
        b.onResolve({ filter: /^@\/server\/platform\.mjs$/ }, () => ({
          path: 'env',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /^@\/app\/chatgpt-auth$/ }, () => ({
          path: 'auth',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (x) => ({
          contents:
            x.path === 'env'
              ? 'export const env=globalThis.__v7Env;'
              : 'export async function getChatGPTUser(){return globalThis.__v7User;}',
          loader: 'js',
        }));
      },
    },
  ],
});
const api = await import(pathToFileURL(join(dir, 'api.mjs')));
const url = 'https://unit.example/api/workspace-state';
const session = (text = 'hello') => ({
  version: 1,
  additions: [],
  experimental: false,
  files: { 'a.txt': 'data' },
  conversations: [{ id: 'c', title: 'Saved', messages: [{ id: 'm', role: 'assistant', text }] }],
  knowledge: [
    {
      id: 'known',
      title: 'Preference',
      content: 'Use concise answers',
      kind: 'preference',
      source: 'user',
      createdAt: '2026-09-10T00:00:00Z',
      updatedAt: '2026-09-10T00:00:00Z',
      enabled: true,
    },
  ],
  connection: {
    baseUrl: 'https://api.experientiallabs.ai/v1',
    model: 'test/model',
    maxTokens: 8192,
    temperature: 0.3,
  },
});
const put = (revision, s, origin = 'https://unit.example') =>
  api.PUT(
    new Request(url, {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, session: JSON.stringify(s) }),
    }),
  );
const row = () =>
  db.prepare('SELECT body,revision FROM workspace_states WHERE user_id=?').get('owner');
test.beforeEach(() => {
  db.exec('DELETE FROM workspace_states');
  blobs.clear();
  failPut = false;
  commitThenThrow = false;
  globalThis.__v7Env.BUCKET = bucket;
  globalThis.__v7User = { userId: 'owner', email: 'owner@example.test' };
});
test('storage isolates identities and rejects cross-origin writes', async () => {
  globalThis.__v7User = null;
  assert.equal((await api.GET()).status, 401);
  globalThis.__v7User = { userId: 'owner' };
  assert.equal((await put(-1, session(), 'https://elsewhere.example')).status, 403);
  assert.equal((await put(-1, session())).status, 200);
  globalThis.__v7User = { userId: 'other' };
  assert.equal((await (await api.GET()).json()).session, null);
});
test('large transcript plus knowledge round-trips through R2 pointer', async () => {
  const saved = session('क'.repeat(800000));
  assert.equal((await put(-1, saved)).status, 200);
  assert.equal(blobs.size, 1);
  const pointer = JSON.parse(row().body);
  assert.equal(pointer.format, 'hikmah.workspace.object.v1');
  assert.match(pointer.key, /^workspaces\/owner\//);
  const restored = JSON.parse((await (await api.GET()).json()).session);
  assert.equal(restored.conversations[0].messages[0].text, saved.conversations[0].messages[0].text);
  assert.deepEqual(
    restored.knowledge,
    saved.knowledge.map((x) => ({ ...x, status: 'saved' })),
  );
});
test('stale large write cleans its orphan and leaves current content unchanged', async () => {
  assert.equal((await put(-1, session('a'.repeat(800000)))).status, 200);
  const existing = new Set(blobs.keys());
  assert.equal((await put(-1, session('b'.repeat(800000)))).status, 409);
  assert.deepEqual(new Set(blobs.keys()), existing);
  assert.equal(
    JSON.parse((await (await api.GET()).json()).session).conversations[0].messages[0].text[0],
    'a',
  );
});
test('failed R2 write leaves prior snapshot and D1 revision intact', async () => {
  assert.equal((await put(-1, session('a'.repeat(800000)))).status, 200);
  const before = row();
  failPut = true;
  assert.notEqual((await put(0, session('b'.repeat(800000)))).status, 200);
  assert.deepEqual(row(), before);
  assert.equal(
    JSON.parse((await (await api.GET()).json()).session).conversations[0].messages[0].text[0],
    'a',
  );
});
test('missing saved R2 object is an explicit restore failure rather than empty workspace', async () => {
  assert.equal((await put(-1, session('a'.repeat(800000)))).status, 200);
  blobs.clear();
  assert.equal((await api.GET()).status, 503);
  assert.equal(row().revision, 0);
});
test('superseded R2 snapshot is removed after successful replacement', async () => {
  assert.equal((await put(-1, session('a'.repeat(800000)))).status, 200);
  const oldKey = JSON.parse(row().body).key;
  assert.equal((await put(0, session('b'.repeat(800000)))).status, 200);
  assert.equal(blobs.has(oldKey), false);
  assert.equal(blobs.size, 1);
});
test('ambiguous database acknowledgment must not delete the newly committed authoritative blob', async () => {
  assert.equal((await put(-1, session('a'.repeat(800000)))).status, 200);
  commitThenThrow = true;
  await put(0, session('b'.repeat(800000)));
  assert.equal(row().revision, 1);
  assert.equal((await api.GET()).status, 200);
  assert.equal(
    JSON.parse((await (await api.GET()).json()).session).conversations[0].messages[0].text[0],
    'b',
  );
});
test.after(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
