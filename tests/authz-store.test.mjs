// Staff roles, bans and the audit log over sqlite.
//
// The store takes the handle rather than opening storage, so these run against
// :memory: with the real migrations — the same shape production has.
// Run: node --test tests/authz-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createAuthzStore } from '../lib/authz/store.ts';

function store() {
  return createAuthzStore(applySchema(new DatabaseSync(':memory:')));
}

test('a role round-trips, and absence is null rather than a default', () => {
  const s = store();
  assert.equal(s.getRole('u1'), null);
  s.setRole('u1', 'support', 'owner1');
  assert.equal(s.getRole('u1'), 'support');
  s.setRole('u1', 'support', 'owner1');
  assert.equal(s.getRole('u1'), 'support', 're-granting is idempotent');
  s.removeRole('u1');
  assert.equal(s.getRole('u1'), null);
});

test('every admin mutation leaves an audit row, newest first', () => {
  const s = store();
  s.logAudit('owner1', 'tier.override', 'u2', 'byok -> managed (manual)');
  s.logAudit('owner1', 'user.ban', 'u3', 'spam');
  const { entries, total } = s.listAudit(50, 0);
  assert.equal(total, 2);
  assert.equal(entries[0].action, 'user.ban', 'newest first');
  assert.equal(entries[0].actorId, 'owner1');
  assert.equal(entries[0].targetUserId, 'u3');
  assert.equal(entries[0].detail, 'spam');
  assert.ok(entries[0].id, 'rows carry an id');
  assert.ok(entries[0].createdAt, 'rows carry a timestamp');
  assert.equal(s.listAudit(1, 1).entries[0].action, 'tier.override', 'offset pages');
});

test('the audit log caps page size so the console cannot be asked for everything', () => {
  const s = store();
  for (let i = 0; i < 5; i++) s.logAudit('owner1', 'tier.override', `u${i}`);
  assert.equal(s.listAudit(10000, 0).entries.length, 5);
  assert.equal(s.listAudit(2, 0).entries.length, 2);
});

test('banning is a set flag the session gate can ask about', () => {
  const s = store();
  assert.equal(s.isBanned('u9'), false);
  s.setBanned('u9', 'owner1', 'abuse');
  assert.equal(s.isBanned('u9'), true);
  s.clearBanned('u9');
  assert.equal(s.isBanned('u9'), false);
});

test('audit detail is optional; the action and actor are not', () => {
  const s = store();
  s.logAudit('owner1', 'role.grant', 'u4');
  const [entry] = s.listAudit(1, 0).entries;
  assert.equal(entry.detail, null);
  assert.equal(entry.targetUserId, 'u4');
});
