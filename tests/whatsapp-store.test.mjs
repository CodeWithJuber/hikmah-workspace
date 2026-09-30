// The WhatsApp store: accounts, consent, templates, identity links,
// messages, webhook dedupe, send approvals, the sent log and the switch.
// Bare in-memory SQLite, no network, no vault.
// Run: node --test tests/whatsapp-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWhatsAppStore, WhatsAppStoreError } from '../lib/whatsapp/store.ts';
import { linkCodeHash } from '../lib/whatsapp/identity.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0035_whatsapp.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  const store = createWhatsAppStore(db, { newId: () => `id${++counter}` });
  return { db, store };
}

const accountFields = (overrides = {}) => ({
  phoneNumberId: 'pn1',
  displayPhoneNumber: '+1 555 0100',
  businessAccountId: 'ba1',
  tokenSecret: 'WHATSAPP_TOKEN_ABC',
  ...overrides,
});

test('an account is recorded, keyed by owner + phone_number_id', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', accountFields());
  assert.equal(account.phoneNumberId, 'pn1');
  assert.equal(store.accountByPhoneNumberId('pn1')?.userId, 'u1');
  assert.equal(store.accountByPhoneNumberId('nope'), undefined);
  assert.equal(store.accounts('u2').length, 0, 'another owner sees nothing');
});

test('reconnecting the same number updates instead of duplicating', (t) => {
  const { store } = setup(t);
  const first = store.upsertAccount('u1', accountFields());
  const second = store.upsertAccount('u1', accountFields({ displayPhoneNumber: '+1 555 0101' }));
  assert.equal(first.id, second.id);
  assert.equal(second.displayPhoneNumber, '+1 555 0101');
});

test('removing an account detaches its messages', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', accountFields());
  store.recordMessage('u1', {
    accountId: account.id,
    direction: 'outbound',
    phone: '+15551234567',
  });
  store.removeAccount(account.id, 'u1');
  assert.equal(store.accounts('u1').length, 0);
  assert.equal(store.messagesFor('u1').length, 1, 'message rows survive, account link clears');
});

test('consent starts unknown and moves on explicit acts', (t) => {
  const { store } = setup(t);
  assert.equal(store.optInFor('u1', '+971500000001'), undefined);
  const row = store.setOptIn('u1', '+971 50 000 0001', 'opted_in', 'api');
  assert.equal(row.phone, '+971500000001', 'phones normalize on write');
  assert.equal(row.state, 'opted_in');
  assert.equal(store.setOptIn('u1', '+971500000001', 'opted_out', 'webhook').state, 'opted_out');
});

test('an unknown opt-in source is refused', (t) => {
  const { store } = setup(t);
  assert.throws(
    () => store.setOptIn('u1', '+971500000001', 'opted_in', 'scraped-list'),
    WhatsAppStoreError,
  );
});

test('templates upsert and the approved set filters', (t) => {
  const { store } = setup(t);
  store.upsertTemplate('u1', { name: 'hello', body: 'Hi {{1}}', status: 'approved' });
  store.upsertTemplate('u1', { name: 'promo', status: 'pending' });
  store.upsertTemplate('u1', { name: 'hello', status: 'rejected' });
  assert.equal(store.templates('u1').length, 2, 'upsert does not duplicate');
  assert.deepEqual(
    store.approvedTemplates('u1').map((row) => row.name),
    [],
    'hello is rejected now, nothing approved',
  );
  assert.throws(
    () => store.upsertTemplate('u1', { name: 'x', status: 'maybe' }),
    WhatsAppStoreError,
  );
});

test('the link flow needs a matching, fresh code', (t) => {
  const { store } = setup(t);
  const nowMs = Date.now();
  store.requestLinkCode(
    'u1',
    '+971500000001',
    linkCodeHash('111 222'),
    new Date(nowMs + 60_000).toISOString(),
  );
  assert.equal(store.linkedUserFor('u1', '+971500000001'), null, 'requested is not linked');
  assert.throws(
    () => store.confirmLink('u1', '+971500000001', linkCodeHash('999 999'), nowMs),
    /does not match/,
  );
  store.confirmLink('u1', '+971500000001', linkCodeHash('111222'), nowMs);
  assert.equal(store.linkedUserFor('u1', '+971500000001'), 'u1');
  store.unlinkPhone('u1', '+971500000001');
  assert.equal(store.linkedUserFor('u1', '+971500000001'), null);
});

test('an expired code cannot confirm a link', (t) => {
  const { store } = setup(t);
  const nowMs = Date.now();
  store.requestLinkCode(
    'u1',
    '+971500000001',
    linkCodeHash('111 222'),
    new Date(nowMs - 1).toISOString(),
  );
  assert.throws(
    () => store.confirmLink('u1', '+971500000001', linkCodeHash('111 222'), nowMs),
    /expired/,
  );
});

test('messages round-trip: wamid lookup, status updates, last inbound', (t) => {
  const { store } = setup(t);
  const inbound = store.recordMessage('u1', {
    direction: 'inbound',
    wamid: 'wamid.in.1',
    phone: '+971500000001',
    bodyPreview: 'hi',
  });
  assert.equal(store.messageByWamid('wamid.in.1', 'u1')?.id, inbound.id);
  assert.ok(store.updateMessageStatus('wamid.in.1', 'u1', 'read'));
  assert.equal(store.messageByWamid('wamid.in.1', 'u1')?.status, 'read');
  assert.equal(store.updateMessageStatus('wamid.ghost', 'u1', 'read'), false);
  assert.equal(store.lastInboundAt('u1', '+971500000001'), inbound.createdAt);
  assert.equal(store.lastInboundAt('u1', '+15551234567'), null);
});

test('webhook events dedupe on the key', (t) => {
  const { store } = setup(t);
  const first = store.recordWebhookEvent({
    dedupeKey: 'msg:1',
    userId: 'u1',
    eventType: 'message',
    payload: '{}',
  });
  const second = store.recordWebhookEvent({
    dedupeKey: 'msg:1',
    userId: 'u1',
    eventType: 'message',
    payload: '{}',
  });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  store.markEventApplied('msg:1');
});

test('approvals are single-use, content-bound and expiring', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', accountFields());
  const approval = store.createSendApproval('u1', account.id, 'hash-1', 60_000);
  assert.equal(store.consumeApproval('u1', approval.token, 'hash-1'), account.id);
  assert.throws(
    () => store.consumeApproval('u1', approval.token, 'hash-1'),
    /used or expired/,
    'a used approval authorizes nothing',
  );
  const other = store.createSendApproval('u1', account.id, 'hash-1', 60_000);
  assert.throws(
    () => store.consumeApproval('u1', other.token, 'hash-2'),
    /changed after approval/,
    'edited content invalidates the approval',
  );
  const expired = store.createSendApproval('u1', account.id, 'hash-1', -1);
  assert.throws(() => store.consumeApproval('u1', expired.token, 'hash-1'), /used or expired/);
});

test('the sent log replays a retried key instead of double-sending', (t) => {
  const { store } = setup(t);
  const account = store.upsertAccount('u1', accountFields());
  const msgA = store.recordMessage('u1', { direction: 'outbound', phone: '+15551234567' });
  const msgB = store.recordMessage('u1', { direction: 'outbound', phone: '+15551234567' });
  const first = store.claimSend('key-1', 'u1', account.id, msgA.id);
  assert.equal(first.claimed, true);
  const replay = store.claimSend('key-1', 'u1', account.id, msgB.id);
  assert.equal(replay.claimed, false);
  assert.equal(replay.messageId, msgA.id, 'the retry sees the original message');
  store.completeSend('key-1', 'sent', 'wamid.out.1');
});

test('the send switch defaults off and flips per owner', (t) => {
  const { store } = setup(t);
  assert.equal(store.sendEnabled('u1'), false);
  store.setSendEnabled('u1', true);
  assert.equal(store.sendEnabled('u1'), true);
  assert.equal(store.sendEnabled('u2'), false);
});

test('outboundSpend sums only outbound estimates', (t) => {
  const { store } = setup(t);
  store.recordMessage('u1', { direction: 'outbound', phone: '+15551234567', costEstimate: 0.01 });
  store.recordMessage('u1', { direction: 'inbound', phone: '+15551234567', costEstimate: 9.99 });
  assert.equal(store.outboundSpend('u1'), 0.01);
});
