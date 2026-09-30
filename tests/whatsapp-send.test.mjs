// The send pipeline. Dry-run is the default: payload built, receipt
// written, Meta never called. Every refusal names its reason; the network
// is always a stub, never the real Meta API.
// Run: node --test tests/whatsapp-send.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWhatsAppStore } from '../lib/whatsapp/store.ts';
import { planSend } from '../lib/whatsapp/send.ts';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(t, routes = []) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0035_whatsapp.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  const store = createWhatsAppStore(db, { newId: () => `id${++counter}` });
  const account = store.upsertAccount('u1', {
    phoneNumberId: 'pn1',
    tokenSecret: 'WHATSAPP_TOKEN_ABC',
  });
  store.setOptIn('u1', '+15551234567', 'opted_in', 'api');
  // An inbound message opens the 24h session window for the happy path.
  store.recordMessage('u1', {
    accountId: account.id,
    direction: 'inbound',
    wamid: 'wamid.in.1',
    phone: '+15551234567',
  });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler(url, init, calls.length);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const context = {
    store,
    userId: 'u1',
    env: {},
    fetchImpl,
    accessToken: async () => 'tok',
    newId: () => `key${++counter}`,
  };
  return { store, account, context, calls };
}

const base = { to: '+1 555 123 4567', body: 'hello from the workspace' };

test('dry-run is the default: payload built, receipt written, Meta untouched', async (t) => {
  const { context, calls, store } = setup(t);
  const receipt = await planSend(context, {
    accountId: context.store.accounts('u1')[0].id,
    ...base,
  });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.metaCalled, false);
  assert.equal(calls.length, 0, 'no network call in dry-run');
  assert.equal(receipt.kind, 'session');
  assert.equal(receipt.payload.type, 'text');
  assert.equal(receipt.payload.text.body, base.body);
  assert.equal(store.message(receipt.messageId, 'u1')?.status, 'dry_run');
});

test('dry-run still needs consent — unknown is not consent', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  await assert.rejects(
    planSend(context, { accountId, to: '+19998887777', body: 'hi' }),
    /No opt-in recorded/,
  );
});

test('dry-run still enforces the 24h window on free-form text', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  store.setOptIn('u1', '+19998887777', 'opted_in', 'api');
  await assert.rejects(
    planSend(context, { accountId, to: '+19998887777', body: 'hi' }),
    /24h window/,
  );
});

test('an approved template dry-runs outside the window', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  store.setOptIn('u1', '+19998887777', 'opted_in', 'api');
  store.upsertTemplate('u1', {
    name: 'hello_world',
    body: 'Hello {{1}}.',
    status: 'approved',
  });
  const receipt = await planSend(context, {
    accountId,
    to: '+19998887777',
    templateName: 'hello_world',
    templateParams: ['Asha'],
  });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.kind, 'template');
  assert.equal(receipt.payload.template.name, 'hello_world');
  assert.equal(receipt.payload.template.components[0].parameters[0].text, 'Asha');
  assert.ok(receipt.costEstimateUsd > 0, 'templates carry a cost estimate');
});

test('a live send needs the owner switch on', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  await assert.rejects(planSend(context, { accountId, ...base, dryRun: false }), /switch it on/);
});

test('a live send needs an approval token', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  await assert.rejects(planSend(context, { accountId, ...base, dryRun: false }), /approval token/);
});

test('WHATSAPP_SEND_FORCE_OFF=1 blocks even an approved, switched-on send', async (t) => {
  const { context, store } = setup(t, [
    ['https://graph.facebook.com/', async () => json({ messages: [{ id: 'wamid.x' }] })],
  ]);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  const approval = store.createSendApproval('u1', accountId, 'h');
  context.env.WHATSAPP_SEND_FORCE_OFF = '1';
  await assert.rejects(
    planSend(context, { accountId, ...base, dryRun: false, approvalToken: approval.token }),
    /force-disabled/,
  );
  assert.equal(context.calls?.length ?? 0, 0);
});

test('a live send calls Meta once, stores the wamid, honours the approval', async (t) => {
  const { context, store, calls } = setup(t, [
    [
      'https://graph.facebook.com/v21.0/pn1/messages',
      async (url, init) => {
        const payload = JSON.parse(init.body);
        assert.equal(payload.to, '+15551234567');
        assert.equal(init.headers.authorization, 'Bearer tok');
        return json({ messages: [{ id: 'wamid.out.42' }] });
      },
    ],
  ]);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  const { sendInputHash } = await import('../lib/whatsapp/send.ts');
  const hash = sendInputHash({
    to: '+15551234567',
    kind: 'session',
    type: 'text',
    templateName: null,
    templateParams: [],
    body: base.body,
  });
  const approval = store.createSendApproval('u1', accountId, hash);
  const receipt = await planSend(context, {
    accountId,
    ...base,
    dryRun: false,
    approvalToken: approval.token,
  });
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.metaCalled, true);
  assert.equal(receipt.wamid, 'wamid.out.42');
  assert.equal(calls.length, 1);
  assert.equal(store.messageByWamid('wamid.out.42', 'u1')?.status, 'sent');
  // The approval is spent: replaying it fails instead of sending twice.
  await assert.rejects(
    planSend(context, { accountId, ...base, dryRun: false, approvalToken: approval.token }),
    /used or expired/,
  );
});

test('a retried idempotency key returns the stored receipt, no second call', async (t) => {
  const { context, store, calls } = setup(t, [
    ['https://graph.facebook.com/', async () => json({ messages: [{ id: 'wamid.out.7' }] })],
  ]);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  const { sendInputHash } = await import('../lib/whatsapp/send.ts');
  const input = {
    to: '+15551234567',
    kind: 'session',
    type: 'text',
    templateName: null,
    templateParams: [],
    body: base.body,
  };
  const approval = (h) => store.createSendApproval('u1', accountId, h);
  const first = await planSend(context, {
    accountId,
    ...base,
    dryRun: false,
    approvalToken: approval(sendInputHash(input)).token,
    idempotencyKey: 'idem-1',
  });
  const second = await planSend(context, {
    accountId,
    ...base,
    dryRun: false,
    approvalToken: approval(sendInputHash(input)).token,
    idempotencyKey: 'idem-1',
  });
  assert.equal(second.replayed, true);
  assert.equal(second.messageId, first.messageId);
  assert.equal(calls.length, 1, 'Meta was called once');
});

test('a Meta refusal is an honest failure, not a silent drop', async (t) => {
  const { context, store } = setup(t, [
    ['https://graph.facebook.com/', async () => json({ error: { message: 'bad token' } }, 401)],
  ]);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  const { sendInputHash } = await import('../lib/whatsapp/send.ts');
  const approval = store.createSendApproval(
    'u1',
    accountId,
    sendInputHash({
      to: '+15551234567',
      kind: 'session',
      type: 'text',
      templateName: null,
      templateParams: [],
      body: base.body,
    }),
  );
  await assert.rejects(
    planSend(context, { accountId, ...base, dryRun: false, approvalToken: approval.token }),
    /Meta refused the message: bad token/,
  );
});

test('a missing access token fails before any network call', async (t) => {
  const { context, store } = setup(t);
  const accountId = store.accounts('u1')[0].id;
  store.setSendEnabled('u1', true);
  context.accessToken = async () => null;
  const { sendInputHash } = await import('../lib/whatsapp/send.ts');
  const approval = store.createSendApproval(
    'u1',
    accountId,
    sendInputHash({
      to: '+15551234567',
      kind: 'session',
      type: 'text',
      templateName: null,
      templateParams: [],
      body: base.body,
    }),
  );
  await assert.rejects(
    planSend(context, { accountId, ...base, dryRun: false, approvalToken: approval.token }),
    /No Meta access token/,
  );
});
