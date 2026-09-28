// Chat v2 read-only conversation shares: token shape, hash-only storage,
// resolve/revoke, and cascade on conversation delete.
// Run: node --test tests/chat-v2-share.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { createSharesStore } from '../lib/chat/shares-store.ts';

async function fresh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-share-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const runs = createRunStore(db);
  const shares = createSharesStore(db);
  runs.createConversation({ id: 'c1', userId: 'u1', title: 'Shared chat' });
  return { db, runs, shares };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

test('tokens are unguessable by construction: 32 random bytes, base64url', async (t) => {
  const { shares } = await fresh(t);
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const { token } = shares.createShare('c1', 'u1');
    assert.match(token, TOKEN_RE); // 43 chars, URL-safe alphabet, no padding
    assert.ok(!seen.has(token), 'two minted tokens must never collide');
    seen.add(token);
  }
});

test('only the hash is stored: the plaintext token never reaches the database', async (t) => {
  const { db, shares } = await fresh(t);
  const { token } = shares.createShare('c1', 'u1');

  const rows = db.prepare('SELECT token_hash, conversation_id FROM conversation_shares').all();
  assert.equal(rows.length, 1);
  // The stored value is the sha256 of the token, and nothing else in the row
  // (or the table's SQL) carries the plaintext.
  assert.equal(rows[0].token_hash, createHash('sha256').update(token, 'utf8').digest('hex'));
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(token), 'plaintext token must not appear in the stored rows');
  const tableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'conversation_shares'")
    .get().sql;
  assert.ok(!tableSql.includes(token));
});

test('resolveToken maps a valid token to its conversation, and nothing else', async (t) => {
  const { shares } = await fresh(t);
  const { token } = shares.createShare('c1', 'u1');

  const resolved = shares.resolveToken(token);
  assert.deepEqual(resolved, { conversation_id: 'c1', user_id: 'u1' });

  // Garbage in, null out: unknown tokens, truncated tokens, empty strings,
  // and absurdly long ones never resolve.
  assert.equal(shares.resolveToken('nope'), null);
  assert.equal(shares.resolveToken(token.slice(0, 20)), null);
  assert.equal(shares.resolveToken(''), null);
  assert.equal(shares.resolveToken(token + 'x'), null);
  assert.equal(shares.resolveToken('x'.repeat(500)), null);
});

test('revoked shares stop resolving', async (t) => {
  const { shares } = await fresh(t);
  const { token } = shares.createShare('c1', 'u1');
  assert.notEqual(shares.resolveToken(token), null);

  assert.equal(shares.revokeShare('c1', 'u1'), true);
  assert.equal(shares.resolveToken(token), null);

  // Revoking again is a no-op, reported honestly.
  assert.equal(shares.revokeShare('c1', 'u1'), false);

  // The row is stamped, not deleted, so a dead link is distinguishable from
  // one that never existed.
  const listed = shares.listShares('u1');
  assert.equal(listed.length, 1);
  assert.notEqual(listed[0].revoked_at, null);
});

test('listShares is scoped to the owner and newest-first', async (t) => {
  const { runs, shares } = await fresh(t);
  runs.createConversation({ id: 'c2', userId: 'u1' });
  runs.createConversation({ id: 'c9', userId: 'u2' });

  shares.createShare('c1', 'u1');
  shares.createShare('c2', 'u1');
  shares.createShare('c9', 'u2');

  const mine = shares.listShares('u1');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((row) => row.user_id === 'u1'));
  assert.ok(mine[0].created_at >= mine[1].created_at);
  assert.deepEqual(shares.listShares('nobody').length, 0);
});

test('deleting the conversation deletes its shares (cascade)', async (t) => {
  const { db, runs, shares } = await fresh(t);
  const { token } = shares.createShare('c1', 'u1');
  assert.notEqual(shares.resolveToken(token), null);

  assert.equal(runs.deleteConversation('c1', 'u1'), true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM conversation_shares').get().n,
    0,
    'no share rows may outlive their conversation',
  );
  assert.equal(shares.resolveToken(token), null);
});

test('activeShare reports an existing link without minting a new token', async (t) => {
  const { shares } = await fresh(t);
  assert.equal(shares.activeShare('c1', 'u1'), null);

  shares.createShare('c1', 'u1');
  const existing = shares.activeShare('c1', 'u1');
  assert.equal(existing.conversation_id, 'c1');
  assert.ok(existing.created_at);

  shares.revokeShare('c1', 'u1');
  assert.equal(shares.activeShare('c1', 'u1'), null);
});
