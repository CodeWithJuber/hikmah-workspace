// The permission matrix: who may do what, decided in one place.
//
// Roles are deliberately separate from billing tiers: a staff role never
// changes what someone's runs cost, and a tier never grants a permission.
// Run: node --test tests/authz-roles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission, isRole, permissionsFor } from '../lib/authz/roles.ts';

test('the owner holds every permission, including the named three', () => {
  for (const permission of [
    'users:read',
    'users:manage',
    'billing:override',
    'runs:execute',
    'audit:read',
  ])
    assert.ok(hasPermission('owner', permission), permission);
});

test('support is read-only: users and the audit log, nothing that mutates', () => {
  assert.ok(hasPermission('support', 'users:read'));
  assert.ok(hasPermission('support', 'audit:read'));
  assert.ok(!hasPermission('support', 'users:manage'), 'cannot grant roles or ban');
  assert.ok(!hasPermission('support', 'billing:override'), 'cannot override tiers or refund');
  assert.ok(!hasPermission('support', 'runs:execute'), 'cannot run as anyone');
});

test('an unknown role fails closed', () => {
  assert.ok(!hasPermission('admin', 'users:read'), 'a legacy string grants nothing');
  assert.ok(!hasPermission(undefined, 'users:read'));
  assert.ok(!hasPermission(null, 'audit:read'));
  assert.ok(!isRole('admin'));
  assert.ok(isRole('owner'));
  assert.ok(isRole('support'));
});

test('permissionsFor returns the matrix, defensively copied', () => {
  const owner = permissionsFor('owner');
  assert.deepEqual([...owner].sort(), [
    'audit:read',
    'billing:override',
    'runs:execute',
    'users:manage',
    'users:read',
  ]);
  owner.push('users:manage');
  assert.equal(permissionsFor('owner').length, 5, 'mutating the copy changes nothing');
  assert.deepEqual([...permissionsFor('support')].sort(), ['audit:read', 'users:read']);
});
