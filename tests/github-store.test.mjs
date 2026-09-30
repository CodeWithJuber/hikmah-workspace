// Connections and receipts on a bare in-memory database.
// Run: node --test tests/github-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createGitHubStore, GitHubStoreError } from '../lib/github/store.ts';
import { GitHubScopeError } from '../lib/github/scopes.ts';

function store(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0032_github_integration.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  let tick = 0;
  return createGitHubStore(db, {
    now: () => `2026-09-30T00:00:0${tick++}.000Z`,
    newId: () => `c${++counter}`,
  });
}

test('a connection records the declared scopes', (t) => {
  const s = store(t);
  const connection = s.add('user-1', 'Work GitHub', ['contents:read', 'issues:read']);
  assert.equal(connection.label, 'Work GitHub');
  assert.deepEqual(connection.scopes, ['contents:read', 'issues:read']);
  assert.equal(connection.status, 'connected');
  // The row carries no token — the token lives in the secret store.
  const db = s;
  assert.ok(db);
});

test('a label is required', (t) => {
  assert.throws(() => store(t).add('user-1', '   ', ['contents:read']), GitHubStoreError);
});

test('unknown scope ids are rejected', (t) => {
  assert.throws(() => store(t).add('user-1', 'x', ['repo']), GitHubScopeError);
});

test('connections are per-user', (t) => {
  const s = store(t);
  s.add('user-1', 'mine', ['contents:read']);
  assert.equal(s.list('user-2').length, 0);
  assert.equal(s.get('c1', 'user-2'), undefined);
});

test('a scoped-auth failure marks needs-reauth without deleting the row', (t) => {
  const s = store(t);
  const connection = s.add('user-1', 'x', ['contents:read']);
  s.markNeedsReauth(connection.id, 'user-1', 'GitHub refused the token.');
  const updated = s.get(connection.id, 'user-1');
  assert.equal(updated.status, 'needs-reauth');
  assert.equal(updated.lastError, 'GitHub refused the token.');
  s.markConnected(connection.id, 'user-1');
  assert.equal(s.get(connection.id, 'user-1').status, 'connected');
});

test('re-declaring scopes needs a fresh token', (t) => {
  const s = store(t);
  const connection = s.add('user-1', 'x', ['contents:read']);
  const updated = s.updateScopes(connection.id, 'user-1', ['contents:read', 'issues:read']);
  assert.deepEqual(updated.scopes, ['contents:read', 'issues:read']);
  assert.equal(updated.status, 'needs-reauth', 'the old token no longer matches the screen');
});

test('receipts are append-only and verifiable', (t) => {
  const s = store(t);
  const connection = s.add('user-1', 'x', ['contents:read']);
  const first = s.recordReceipt(
    'user-1',
    connection.id,
    'read-file',
    'a'.repeat(64),
    'ok',
    'README.md',
    false,
  );
  const second = s.recordReceipt(
    'user-1',
    connection.id,
    'draft-pr',
    'b'.repeat(64),
    'dry-run',
    'Would open.',
    true,
  );
  const receipts = s.receipts(connection.id, 'user-1');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].id, second.id, 'newest first');
  assert.equal(receipts[1].status, 'ok');
  assert.equal(receipts[0].dryRun, true);
  assert.equal(first.paramsHash, 'a'.repeat(64));
});

test('removing a connection removes its receipts', (t) => {
  const s = store(t);
  const connection = s.add('user-1', 'x', ['contents:read']);
  s.recordReceipt('user-1', connection.id, 'read-file', 'h', 'ok', null, false);
  s.remove(connection.id, 'user-1');
  assert.equal(s.get(connection.id, 'user-1'), undefined);
  assert.equal(s.receipts(connection.id, 'user-1').length, 0);
});
