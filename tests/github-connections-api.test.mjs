// The /api/github request layer: token verified before saving, token dies
// with the connection. Run: node --test tests/github-connections-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { githubRequest } from '../lib/github/connections-api.ts';

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

function setup(t, fetchHandler) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0032_github_integration.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const saved = new Map();
  const secrets = {
    async save(userId, input) {
      saved.set(input.name, input);
    },
    async remove(userId, name) {
      saved.delete(name);
    },
    async resolve(userId, name, destination) {
      const row = saved.get(name);
      if (!row || row.destination !== destination) throw new Error('missing');
      return row.value;
    },
  };
  const context = {
    db,
    userId: 'user-1',
    secrets,
    fetchImpl: async (url, init) => fetchHandler(url, init),
  };
  const request = (method, body, query = '') =>
    new Request(`https://app.test/api/github${query}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  return { context, request, saved };
}

test('connect verifies the token before saving anything', async (t) => {
  let calls = 0;
  const { context, request, saved } = setup(t, async () => {
    calls++;
    return jsonResponse(200, { login: 'octocat' });
  });
  const response = await githubRequest(
    request('POST', { label: 'Work', token: 'ghp_x', scopes: ['contents:read'] }),
    context,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.login, 'octocat');
  assert.equal(body.connections.length, 1);
  assert.equal(calls, 1, 'the token was verified against GitHub');
  assert.equal(saved.size, 1, 'the token was sealed in the secret store');
  const [name, sealed] = [...saved.entries()][0];
  assert.match(name, /^GITHUB_[A-Z0-9]+$/);
  assert.match(sealed.destination, /^github:[a-z0-9]+$/, 'bound to the connection row');
  assert.equal(sealed.value, 'ghp_x');
});

test('a bad token saves nothing', async (t) => {
  const { context, request, saved } = setup(t, async () =>
    jsonResponse(401, { message: 'Bad credentials' }),
  );
  const response = await githubRequest(
    request('POST', { label: 'Work', token: 'bad', scopes: ['contents:read'] }),
    context,
  );
  assert.equal(response.status, 502);
  assert.equal(saved.size, 0);
  const listed = await (await githubRequest(request('GET'), context)).json();
  assert.equal(listed.connections.length, 0);
});

test('unknown scope ids are rejected at the door', async (t) => {
  const { context, request } = setup(t, async () => jsonResponse(200, { login: 'x' }));
  const response = await githubRequest(
    request('POST', { label: 'Work', token: 't', scopes: ['repo'] }),
    context,
  );
  assert.equal(response.status, 400);
});

test('disconnect deletes the token with the connection', async (t) => {
  const { context, request, saved } = setup(t, async () => jsonResponse(200, { login: 'x' }));
  const created = await (
    await githubRequest(
      request('POST', { label: 'Work', token: 't', scopes: ['contents:read'] }),
      context,
    )
  ).json();
  const id = created.connections[0].id;
  assert.equal(saved.size, 1);
  const deleted = await (
    await githubRequest(request('DELETE', undefined, `?id=${id}`), context)
  ).json();
  assert.equal(deleted.connections.length, 0);
  assert.equal(saved.size, 0, 'no live credential left behind');
});

test('anonymous callers get a 401', async (t) => {
  const { request } = setup(t, async () => jsonResponse(200, {}));
  const response = await githubRequest(request('GET'), {
    db: new DatabaseSync(':memory:'),
    userId: null,
    secrets: { save: async () => {}, remove: async () => {}, resolve: async () => '' },
  });
  assert.equal(response.status, 401);
});
