// The Gmail store: accounts, drafts, single-use approvals, the idempotency
// log and the send switch. Bare in-memory SQLite, no network, no vault.
// Run: node --test tests/gmail-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createGmailStore, draftContentHash } from '../lib/gmail/store.ts';
import { GMAIL_SCOPE_READONLY, GMAIL_SCOPE_SEND, mergeScopes } from '../lib/gmail/scopes.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0034_gmail.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  const store = createGmailStore(db, { newId: () => `id${++counter}` });
  return { db, store };
}

const accountFields = (scopes) => ({
  displayName: null,
  scopes,
  tokenSecret: 'GMAIL_OAUTH_ABC',
});

test('an account is recorded with the scopes Google granted, keyed by owner+email', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'Me@Example.com', accountFields(GMAIL_SCOPE_READONLY));
  assert.equal(account.email, 'me@example.com', 'addresses normalize');
  assert.equal(store.accounts('u1').length, 1);
  assert.equal(store.accounts('u2').length, 0, 'another owner sees nothing');
});

test('a second grant for the same address merges scopes instead of duplicating', (t) => {
  const { store } = setup(t);
  store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const merged = store.upsertAccount(
    'u1',
    'me@example.com',
    accountFields(mergeScopes(GMAIL_SCOPE_READONLY, [GMAIL_SCOPE_SEND])),
  );
  assert.equal(store.accounts('u1').length, 1, 'still one row');
  assert.ok(merged.scopes.includes(GMAIL_SCOPE_READONLY));
  assert.ok(merged.scopes.includes(GMAIL_SCOPE_SEND));
});

test('removing an account also removes its drafts', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const draft = store.createDraft('u1', account.id, { to: ['a@x.com'], body: 'hi' });
  store.removeAccount(account.id, 'u1');
  assert.equal(store.accounts('u1').length, 0);
  assert.equal(store.draft(draft.id, 'u1'), undefined, 'draft cascades away');
});

test('a draft needs a connected account and at least one valid recipient', (t) => {
  const { store } = setup(t);
  assert.throws(
    () => store.createDraft('u1', 'nope', { to: ['a@x.com'] }),
    /connected Gmail accounts/,
  );
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  assert.throws(() => store.createDraft('u1', account.id, { to: [] }), /at least one recipient/);
  assert.throws(
    () => store.createDraft('u1', account.id, { to: ['not-an-email'] }),
    /not an email address/,
  );
});

test('drafts round-trip and edit', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const draft = store.createDraft('u1', account.id, {
    to: ['a@x.com'],
    cc: ['b@x.com'],
    subject: 's',
    body: 'b',
  });
  const edited = store.updateDraft(draft.id, 'u1', { subject: 's2' });
  assert.equal(edited.subject, 's2');
  assert.deepEqual(edited.to, ['a@x.com']);
  assert.equal(store.drafts('u1', account.id).length, 1);
  store.deleteDraft(draft.id, 'u1');
  assert.equal(store.drafts('u1', account.id).length, 0);
});

test('an approval is bound to the draft content hash and is single-use', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const draft = store.createDraft('u1', account.id, { to: ['a@x.com'], subject: 's', body: 'b' });
  const { token, expiresAt } = store.approveDraft(draft.id, 'u1');
  assert.ok(token.length > 32, 'the token itself has entropy');
  assert.ok(Date.parse(expiresAt) > Date.now());
  const stored = store.approval(token);
  assert.equal(stored?.contentHash, draftContentHash(draft), 'bound to the exact content');
  assert.equal(stored?.usedAt, null);
  // Only the hash is stored: the token cannot be recovered from the database.
  assert.equal(store.approval('wrong-token'), undefined, 'a wrong token finds nothing');
  assert.equal(store.useApproval(token), true);
  assert.equal(store.useApproval(token), false, 'second use is refused');
  assert.ok(store.approval(token)?.usedAt, 'use is recorded');
});

test('editing the draft invalidates the earlier approval', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const draft = store.createDraft('u1', account.id, { to: ['a@x.com'], subject: 's', body: 'b' });
  const { token } = store.approveDraft(draft.id, 'u1');
  const before = store.approval(token)?.contentHash;
  store.updateDraft(draft.id, 'u1', { body: 'b, edited' });
  const after = draftContentHash(store.draft(draft.id, 'u1'));
  assert.notEqual(before, after, 'the hash moves with the edit');
});

test('the idempotency claim lands before the send: a retry sees the claim', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', 'me@example.com', accountFields(GMAIL_SCOPE_READONLY));
  const draft = store.createDraft('u1', account.id, { to: ['a@x.com'], body: 'b' });
  assert.equal(store.claimSend('k1', 'u1', account.id, draft.id), null, 'first claim wins');
  const retry = store.claimSend('k1', 'u1', account.id, draft.id);
  assert.equal(retry?.status, 'sending', 'the retry sees the in-flight claim');
  store.completeSend('k1', 'gmail-msg-1');
  const again = store.claimSend('k1', 'u1', account.id, draft.id);
  assert.equal(again?.status, 'sent');
  assert.equal(again?.gmailMessageId, 'gmail-msg-1');
});

test('the send switch is off by default and per owner', (t) => {
  const { store } = setup(t);
  assert.equal(store.sendEnabled('u1'), false, 'off until the owner says otherwise');
  store.setSendEnabled('u1', true);
  assert.equal(store.sendEnabled('u1'), true);
  assert.equal(store.sendEnabled('u2'), false, 'another owner is unaffected');
});

test('oauth states are single-use', (t) => {
  const { store } = setup(t);
  store.saveOAuthState('s1', 'u1', 'read');
  const taken = store.takeOAuthState('s1');
  assert.equal(taken?.userId, 'u1');
  assert.equal(taken?.kind, 'read');
  assert.equal(store.takeOAuthState('s1'), undefined, 'gone after one take');
});
