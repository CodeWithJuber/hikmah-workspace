// Signed webhook ingestion end to end: verify -> route by phone_number_id ->
// dedupe -> store -> apply -> receipt. Status updates for wamids we never
// sent stay unknown, honestly.
// Run: node --test tests/whatsapp-webhook.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWhatsAppStore } from '../lib/whatsapp/store.ts';
import { ingestWebhook, mapMetaStatus } from '../lib/whatsapp/webhook.ts';
import { signForTest } from '../lib/whatsapp/signature.ts';
import { webhookRequest } from '../lib/whatsapp/api.ts';

const SECRET = 'hook-secret';
const VERIFY_TOKEN = 'verify-me';

function setup(t) {
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
  const context = {
    db,
    userId: null,
    env: { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN },
    fetchImpl: async () => {
      throw new Error('no network in webhook tests');
    },
    getAccessToken: async () => null,
  };
  return { store, account, context };
}

const entry = (value) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value }] }],
});
const meta = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '15550100', phone_number_id: 'pn1' },
};

function inboundBody(id, from, textBody) {
  return JSON.stringify(
    entry({
      ...meta,
      contacts: [{ profile: { name: 'Asha' }, wa_id: from.replace(/\D/g, '') }],
      messages: [
        {
          id,
          from,
          type: 'text',
          timestamp: '1700000000',
          text: { body: textBody },
        },
      ],
    }),
  );
}

function statusBody(id, status, timestamp = '1700000100') {
  return JSON.stringify(
    entry({
      ...meta,
      statuses: [{ id, status, timestamp, recipient_id: '15551234567' }],
    }),
  );
}

async function post(context, rawBody, signature) {
  const request = new Request('http://x/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature ?? signForTest(rawBody, SECRET) },
    body: rawBody,
  });
  return webhookRequest(request, context);
}

test('a signed inbound message is stored with a receipt', async (t) => {
  const { context, store } = setup(t);
  const body = inboundBody('wamid.in.1', '+15551234567', 'hello there');
  const response = await post(context, body);
  assert.equal(response.status, 200);
  const { receipt } = await response.json();
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.inbound, 1);
  assert.equal(receipt.deduped, 0);
  assert.equal(store.messageByWamid('wamid.in.1', 'u1')?.status, 'received');
});

test('a forged signature is a 401 and nothing is stored', async (t) => {
  const { context, store } = setup(t);
  const body = inboundBody('wamid.in.1', '+15551234567', 'hello');
  const response = await post(context, body, 'sha256=' + '0'.repeat(64));
  assert.equal(response.status, 401);
  assert.equal(store.messageByWamid('wamid.in.1', 'u1'), undefined);
});

test('an event for an unknown number is a 404, not a crash', async (t) => {
  const { context } = setup(t);
  const body = JSON.stringify(
    entry({
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'pn-ghost' },
      messages: [],
    }),
  );
  const response = await post(context, body);
  assert.equal(response.status, 404);
});

test('Meta retries dedupe: the second delivery applies nothing', async (t) => {
  const { context, store } = setup(t);
  const body = inboundBody('wamid.in.9', '+15551234567', 'twice');
  const first = await (await post(context, body)).json();
  const second = await (await post(context, body)).json();
  assert.equal(first.receipt.applied, 1);
  assert.equal(second.receipt.deduped, 1);
  assert.equal(second.receipt.applied, 0);
  assert.equal(store.messagesFor('u1', '+15551234567').length, 1);
});

test('STOP via webhook opts the number out; START opts it back in', async (t) => {
  const { context, store } = setup(t);
  await post(context, inboundBody('wamid.s1', '+15551234567', 'please STOP'));
  // 'please STOP' is not a whole-message keyword — no state change.
  assert.equal(store.optInFor('u1', '+15551234567'), undefined);
  await post(context, inboundBody('wamid.s2', '+15551234567', 'STOP'));
  assert.equal(store.optInFor('u1', '+15551234567')?.state, 'opted_out');
  const { receipt } = await (
    await post(context, inboundBody('wamid.s3', '+15551234567', 'START'))
  ).json();
  assert.equal(receipt.optIns, 1);
  assert.equal(store.optInFor('u1', '+15551234567')?.state, 'opted_in');
});

test('delivery and read statuses map onto our outbound rows', async (t) => {
  const { context, store } = setup(t);
  store.recordMessage('u1', {
    direction: 'outbound',
    wamid: 'wamid.out.1',
    phone: '+15551234567',
    status: 'sent',
  });
  const delivered = await (await post(context, statusBody('wamid.out.1', 'delivered'))).json();
  assert.equal(delivered.receipt.statusUpdates, 1);
  assert.equal(store.messageByWamid('wamid.out.1', 'u1')?.status, 'delivered');
  await post(context, statusBody('wamid.out.1', 'read'));
  assert.equal(store.messageByWamid('wamid.out.1', 'u1')?.status, 'read');
});

test('a status for a wamid we never sent stays unknown, honestly', async (t) => {
  const { context } = setup(t);
  const { receipt } = await (await post(context, statusBody('wamid.ghost', 'delivered'))).json();
  assert.deepEqual(receipt.unknownWamids, ['wamid.ghost']);
  assert.equal(receipt.statusUpdates, 0);
});

test('a non-JSON body is a 400', async (t) => {
  const { context } = setup(t);
  const response = await post(context, 'not json{');
  assert.equal(response.status, 400);
});

test('the GET handshake answers the challenge on a matching token', async (t) => {
  const { context } = setup(t);
  const good = new Request(
    'http://x/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CHALLENGE',
  );
  const response = await webhookRequest(good, context);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'CHALLENGE');

  const bad = new Request(
    'http://x/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE',
  );
  assert.equal((await webhookRequest(bad, context)).status, 403);
});

test('Meta status vocabulary maps honestly; unknown stays unknown', () => {
  assert.equal(mapMetaStatus('sent'), 'sent');
  assert.equal(mapMetaStatus('delivered'), 'delivered');
  assert.equal(mapMetaStatus('read'), 'read');
  assert.equal(mapMetaStatus('failed'), 'failed');
  assert.equal(mapMetaStatus('deleted'), 'unknown');
  assert.equal(mapMetaStatus(''), 'unknown');
});

test('ingestWebhook without a configured app secret refuses to verify', async (t) => {
  const { store, account } = setup(t);
  await assert.rejects(
    ingestWebhook(
      { store, userId: 'u1', accountId: account.id, appSecret: null },
      { rawBody: '{}', signatureHeader: signForTest('{}', SECRET) },
    ),
    /did not verify/,
  );
});
