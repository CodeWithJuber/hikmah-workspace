// The Gmail scope grants: what each grant asks for, how grants merge, and
// what the stored scope string permits. Scopes are the enforcement behind
// every read and send.
// Run: node --test tests/gmail-scopes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPE_SEND,
  canRead,
  canSend,
  mergeScopes,
  parseScopes,
  scopeLabels,
  scopesForGrant,
} from '../lib/gmail/scopes.ts';

test('the read grant asks only for readonly, the send grant for compose+send', () => {
  assert.deepEqual(scopesForGrant('read'), [GMAIL_SCOPE_READONLY]);
  assert.deepEqual(scopesForGrant('send'), [GMAIL_SCOPE_COMPOSE, GMAIL_SCOPE_SEND]);
});

test('an incremental send grant merges into the earlier read grant', () => {
  const afterRead = mergeScopes('', [GMAIL_SCOPE_READONLY]);
  assert.ok(canRead(afterRead));
  assert.ok(!canSend(afterRead));
  const afterSend = mergeScopes(afterRead, [GMAIL_SCOPE_COMPOSE, GMAIL_SCOPE_SEND]);
  assert.ok(canRead(afterSend));
  assert.ok(canSend(afterSend));
  // Merging twice does not duplicate.
  assert.equal(mergeScopes(afterSend, [GMAIL_SCOPE_SEND]), afterSend);
});

test('compose alone permits sending', () => {
  assert.ok(canSend(GMAIL_SCOPE_COMPOSE));
  assert.ok(!canRead(GMAIL_SCOPE_COMPOSE));
});

test('a send-only account cannot read', () => {
  const scopes = mergeScopes('', [GMAIL_SCOPE_COMPOSE, GMAIL_SCOPE_SEND]);
  assert.ok(!canRead(scopes));
});

test('empty and junk scope strings permit nothing', () => {
  assert.ok(!canRead(''));
  assert.ok(!canSend(null));
  assert.ok(!canRead('https://www.googleapis.com/auth/gmail.metadata'));
  assert.deepEqual(parseScopes('  '), []);
});

test('labels describe the grant in human words', () => {
  assert.deepEqual(scopeLabels(GMAIL_SCOPE_READONLY), ['Read mail']);
  assert.deepEqual(scopeLabels(mergeScopes(GMAIL_SCOPE_READONLY, [GMAIL_SCOPE_SEND])), [
    'Read mail',
    'Send mail',
  ]);
  assert.deepEqual(scopeLabels(''), []);
});
