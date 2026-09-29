// The remembered-tools list behind the MCP settings screen: what the owner
// said yes to, and taking it back. The grant itself stays bound to the
// connector account, tool, fingerprint and scope in the store; this is the
// API boundary over it.
// Run: node --test tests/mcp-consents-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { consentsRequest } from '../lib/mcp/consents-api.ts';
import { createMcpStore } from '../lib/mcp/store.ts';
import { toolFingerprint } from '../lib/mcp/manager.ts';

const ORIGIN = 'https://hikmah.test';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0005_mcp.sql', '0026_mcp_consent.sql', '0029_mcp_consent_expiry.sql'])
    db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  const store = createMcpStore(db, { newId: () => `s${++counter}` });
  return { db, store };
}

const call = (method, query, userId, db) =>
  consentsRequest(new Request(`${ORIGIN}/api/mcp-servers/consents${query}`, { method }), {
    db,
    userId,
  });

const fingerprint = toolFingerprint({ name: 'fetch_quran', description: 'Fetch a verse.' });

test('listing shows what was remembered, without the fingerprint', async (t) => {
  const { db, store } = setup(t);
  const id = store.list('user-1').find((row) => row.name === 'quran').id;
  store.update(id, 'user-1', { enabled: true });
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', { ttlMs: 3_600_000 });

  const response = await call('GET', `?serverId=${id}`, 'user-1', db);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.consents.length, 1);
  assert.equal(body.consents[0].toolName, 'fetch_quran');
  assert.equal(body.consents[0].scope, 'always');
  assert.ok(body.consents[0].expiresAt, 'the expiry travels with the grant');
  assert.ok(!('fingerprint' in body.consents[0]), 'the binding never leaves the store');
});

test('revoking forgets the tool; the next call asks again', async (t) => {
  const { db, store } = setup(t);
  const id = store.list('user-1').find((row) => row.name === 'quran').id;
  store.update(id, 'user-1', { enabled: true });
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');

  const response = await call(
    'DELETE',
    `?serverId=${id}&toolName=fetch_quran&scope=always`,
    'user-1',
    db,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.consents.length, 0);
  assert.equal(store.consents(id).length, 0);
});

test('a server that is not yours is not listed and not revoked', async (t) => {
  const { db, store } = setup(t);
  const id = store.list('user-1').find((row) => row.name === 'quran').id;
  store.update(id, 'user-1', { enabled: true });
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');

  assert.equal((await call('GET', `?serverId=${id}`, 'user-2', db)).status, 404);
  assert.equal(
    (await call('DELETE', `?serverId=${id}&toolName=fetch_quran&scope=always`, 'user-2', db))
      .status,
    404,
  );
  assert.equal(store.consents(id).length, 1, 'the grant survives the attempt');
});

test('anonymous callers get nothing', async (t) => {
  const { db } = setup(t);
  const response = await call('GET', '?serverId=nope', null, db);
  assert.equal(response.status, 401);
});

test('revoking without naming the tool is refused', async (t) => {
  const { db, store } = setup(t);
  const id = store.list('user-1').find((row) => row.name === 'quran').id;
  const response = await call('DELETE', `?serverId=${id}`, 'user-1', db);
  assert.equal(response.status, 400);
});
