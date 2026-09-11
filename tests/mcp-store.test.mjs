// MCP servers are rows now, not entries in a JSON blob, and the tool pins are
// what stand between an approved description and one quietly rewritten later.
// Run: node --test tests/mcp-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { McpStoreError, createMcpStore, publicServer, toRecord } from '../lib/mcp/store.ts';
import { DEFAULT_SERVERS } from '../lib/mcp/defaults.ts';

function store(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0005_mcp.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  return createMcpStore(db, { newId: () => `s${++counter}` });
}

test('a fresh owner gets the catalogue without having to find it', (t) => {
  // A brand-new install previously had no servers at all, so the model had no
  // grounded source for anything.
  const rows = store(t).list('user-1');
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    DEFAULT_SERVERS.map((server) => server.name).sort(),
  );
});

test('only the servers meant to be on are on', (t) => {
  const enabled = store(t)
    .enabled('user-1')
    .map((row) => row.name);
  assert.deepEqual(
    enabled,
    DEFAULT_SERVERS.filter((server) => server.enabled).map((server) => server.name),
  );
  assert.ok(enabled.includes('quran'), 'the grounded Quran source is the one default that is on');
});

test('seeding happens once, not on every read', (t) => {
  const s = store(t);
  const first = s.list('user-1');
  const second = s.list('user-1');
  assert.equal(first.length, second.length);
  assert.deepEqual(
    first.map((row) => row.id),
    second.map((row) => row.id),
  );
});

test('a new catalogue entry reaches an owner who already has rows', (t) => {
  // Seeding lives here rather than in a migration precisely so this works.
  const s = store(t);
  s.list('user-1');
  s.remove(s.list('user-1')[0].id, 'user-1');
  assert.equal(s.list('user-1').length, DEFAULT_SERVERS.length, 'the missing one comes back');
});

test("one owner's servers are invisible to another", (t) => {
  const s = store(t);
  const mine = s.list('user-1');
  s.list('user-2');
  assert.equal(s.get(mine[0].id, 'user-2'), undefined);
});

test('a pasted .mcp.json entry is saved, disabled and untrusted', (t) => {
  // Nothing arrives trusted: trust is something the owner grants after reading
  // what the server offers.
  const s = store(t);
  const row = s.add('user-1', 'local-docs', { type: 'http', url: 'https://docs.example.com/mcp' });
  assert.equal(row.enabled, 0);
  assert.equal(row.trusted, 0);
  assert.equal(row.approval, 'ask');
  assert.equal(row.status, 'disabled');
});

test('a malformed or duplicate server is refused with a reason', (t) => {
  const s = store(t);
  s.list('user-1');
  assert.throws(
    () => s.add('user-1', 'quran', { type: 'http', url: 'https://x.test' }),
    McpStoreError,
  );
  assert.throws(
    () => s.add('user-1', 'bad name', { type: 'http', url: 'https://x.test' }),
    McpStoreError,
  );
  assert.throws(() => s.add('user-1', 'ok', { nonsense: true }), Error);
});

test('enabling a server clears the error it last failed with', (t) => {
  // Otherwise a stale message sits next to a server that is about to be retried.
  const s = store(t);
  const row = s.list('user-1').find((entry) => entry.name === 'context7');
  s.setStatus(row.id, 'failed', 'Connection refused.');
  const updated = s.update(row.id, 'user-1', { enabled: true });
  assert.equal(updated.status, 'pending');
  assert.equal(updated.last_error, null);
});

test('an unknown approval mode is refused rather than stored', (t) => {
  const s = store(t);
  const row = s.list('user-1')[0];
  assert.throws(() => s.update(row.id, 'user-1', { approval: 'always' }), McpStoreError);
});

test('one user cannot change another user’s server', (t) => {
  const s = store(t);
  const row = s.list('user-1')[0];
  s.list('user-2');
  assert.throws(() => s.update(row.id, 'user-2', { enabled: true }), McpStoreError);
});

test('tool pins are recorded per server and read back', (t) => {
  const s = store(t);
  const [first, second] = s.list('user-1');
  s.pin(first.id, 'fetch_quran', 'hash-a');
  s.pin(second.id, 'fetch_quran', 'hash-b');
  assert.equal(s.pins(first.id).get('fetch_quran'), 'hash-a');
  assert.equal(s.pins(second.id).get('fetch_quran'), 'hash-b', 'pins do not leak across servers');
});

test('re-pinning a tool replaces its hash rather than duplicating it', (t) => {
  const s = store(t);
  const row = s.list('user-1')[0];
  s.pin(row.id, 'fetch_quran', 'old');
  s.pin(row.id, 'fetch_quran', 'new');
  assert.equal(s.pins(row.id).size, 1);
  assert.equal(s.pins(row.id).get('fetch_quran'), 'new');
});

test('removing a server takes its pins with it', (t) => {
  // A pin outliving its server would silently pre-approve a description for a
  // server re-added under the same name later.
  const s = store(t);
  const row = s.list('user-1')[0];
  s.pin(row.id, 'fetch_quran', 'hash');
  s.remove(row.id, 'user-1');
  assert.equal(s.pins(row.id).size, 0);
});

test('a row becomes the record the manager expects', (t) => {
  const s = store(t);
  const row = s.update(s.list('user-1')[0].id, 'user-1', {
    trusted: true,
    allowTools: ['mcp__quran__fetch_*'],
    denyTools: ['mcp__quran__admin_*'],
  });
  const record = toRecord(row);
  assert.equal(record.trusted, true);
  assert.deepEqual(record.allowTools, ['mcp__quran__fetch_*']);
  assert.deepEqual(record.denyTools, ['mcp__quran__admin_*']);
  assert.equal(record.config.type, 'http');
});

test('what the settings screen sees carries no credential', (t) => {
  // Headers can hold a resolved token, so the shape of the connection is
  // reported and the values sent with it are not.
  const s = store(t);
  const row = s.add('user-1', 'private', {
    type: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer super-secret-token' },
  });
  const shown = JSON.stringify(publicServer(row));
  assert.equal(shown.includes('super-secret-token'), false);
  assert.equal(shown.includes('Authorization'), false);
  assert.match(shown, /api\.example\.com/, 'the owner still sees where it connects');
});
