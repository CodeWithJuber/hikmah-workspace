// The scoped authorization model: every exemplar action declares the
// permissions it needs, and the flow refuses anything the connection was not
// granted. Run: node --test tests/github-scopes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_SCOPES,
  EXEMPLAR_ACTIONS,
  isWriteAction,
  missingScopes,
  parseDeclaredScopes,
  GitHubScopeError,
} from '../lib/github/scopes.ts';

test('every action declares the scopes it needs', () => {
  for (const action of EXEMPLAR_ACTIONS) {
    const scopes = missingScopes([], action);
    assert.ok(scopes.length > 0, `${action} must need at least one scope`);
    const known = new Set(GITHUB_SCOPES.map((scope) => scope.id));
    for (const scope of scopes) assert.ok(known.has(scope), `${scope} is a real catalogue id`);
  }
});

test('only draft-pr is a write action', () => {
  assert.equal(isWriteAction('draft-pr'), true);
  for (const action of EXEMPLAR_ACTIONS.filter((a) => a !== 'draft-pr'))
    assert.equal(isWriteAction(action), false, `${action} must be read-only`);
});

test('proposing a patch needs no write permission', () => {
  // The proposal is computed locally from fetched content; it writes nothing.
  assert.deepEqual(missingScopes([], 'propose-patch'), ['contents:read']);
});

test('missingScopes names exactly what is missing', () => {
  assert.deepEqual(missingScopes(['contents:read'], 'read-file'), []);
  assert.deepEqual(missingScopes([], 'read-file'), ['contents:read']);
  assert.deepEqual(missingScopes(['contents:read'], 'surface-checks'), [
    'pull_requests:read',
    'checks:read',
  ]);
  assert.deepEqual(missingScopes(['contents:write', 'pull_requests:write'], 'draft-pr'), []);
});

test('declared scopes must come from the catalogue', () => {
  assert.deepEqual(parseDeclaredScopes(['contents:read', 'issues:read']), [
    'contents:read',
    'issues:read',
  ]);
  assert.throws(() => parseDeclaredScopes([]), GitHubScopeError, 'empty means no grant at all');
  assert.throws(
    () => parseDeclaredScopes(['repo']),
    GitHubScopeError,
    'a classic-scope name is not offered',
  );
  assert.deepEqual(
    parseDeclaredScopes(['contents:read', 'contents:read']),
    ['contents:read'],
    'duplicates are collapsed, not doubled',
  );
});
