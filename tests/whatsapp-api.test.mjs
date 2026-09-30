// The route handlers behind /api/whatsapp/*, through api.ts with an
// injected context: owner-scoped accounts, consent, identity linking,
// templates, the send switch and message receipts.
// Run: node --test tests/whatsapp-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  accountsRequest,
  optinRequest,
  identityRequest,
  templatesRequest,
  sendRequest,
  settingsRequest,
  messagesRequest,
} from '../lib/whatsapp/api.ts';

function setup(t, userId = 'u1') {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0035_whatsapp.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const context = {
    db,
    userId,
    env: {},
    fetchImpl: async () => {
      throw new Error('no network in api tests');
    },
    getAccessToken: async () => null,
  };
  return { db, context };
}

const post = (path, body) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path) => new Request(`http://x${path}`);

test('accounts connect, list per owner, and refuse without a session', async (t) => {
  const { context } = setup(t);
  const created = await accountsRequest(
    post('/api/whatsapp/accounts', { phoneNumberId: 'pn1', tokenSecret: 'WATOK' }),
    context,
  );
  assert.equal(created.status, 201);
  const listed = await accountsRequest(get('/api/whatsapp/accounts'), context);
  assert.equal((await listed.json()).accounts.length, 1);

  const denied = await accountsRequest(get('/api/whatsapp/accounts'), { ...context, userId: null });
  assert.equal(denied.status, 401);
});

test('opt-in reads unknown, writes explicit state', async (t) => {
  const { context } = setup(t);
  const before = await optinRequest(get('/api/whatsapp/optin?phone=%2B15551234567'), context);
  const beforeJson = await before.json();
  assert.equal(beforeJson.state, 'unknown');
  assert.equal(beforeJson.maySend, false);

  const written = await optinRequest(
    post('/api/whatsapp/optin', { phone: '+15551234567', action: 'opt_in' }),
    context,
  );
  assert.equal((await written.json()).state, 'opted_in');
  const after = await optinRequest(get('/api/whatsapp/optin?phone=%2B15551234567'), context);
  assert.equal((await after.json()).maySend, true);
});

test('identity links only through the code the owner confirms', async (t) => {
  const { context } = setup(t);
  const requested = await identityRequest(
    post('/api/whatsapp/identity', { action: 'request_code', phone: '+15551234567' }),
    context,
  );
  const { code } = await requested.json();
  assert.match(code, /^\d{3} \d{3}$/);

  const wrong = await identityRequest(
    post('/api/whatsapp/identity', { action: 'confirm', phone: '+15551234567', code: '000 000' }),
    context,
  );
  assert.equal(wrong.status, 403);

  const confirmed = await identityRequest(
    post('/api/whatsapp/identity', { action: 'confirm', phone: '+15551234567', code }),
    context,
  );
  assert.equal((await confirmed.json()).linked, true);

  const unlinked = await identityRequest(
    post('/api/whatsapp/identity', { action: 'unlink', phone: '+15551234567' }),
    context,
  );
  assert.equal((await unlinked.json()).linked, false);
});

test('templates list and upsert per owner', async (t) => {
  const { context } = setup(t);
  const created = await templatesRequest(
    post('/api/whatsapp/templates', { name: 'hello', body: 'Hi {{1}}', status: 'approved' }),
    context,
  );
  assert.equal(created.status, 201);
  const listed = await templatesRequest(get('/api/whatsapp/templates'), context);
  assert.deepEqual(
    (await listed.json()).templates.map((row) => row.name),
    ['hello'],
  );
  const other = await templatesRequest(get('/api/whatsapp/templates'), {
    ...context,
    userId: 'u2',
  });
  assert.equal((await other.json()).templates.length, 0);
});

test('the send switch flips per owner and reports the kill-switch', async (t) => {
  const { context } = setup(t);
  const before = await settingsRequest(get('/api/whatsapp/settings'), context);
  assert.equal((await before.json()).sendEnabled, false);

  const flipped = await settingsRequest(
    new Request('http://x/api/whatsapp/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendEnabled: true }),
    }),
    context,
  );
  assert.equal((await flipped.json()).sendEnabled, true);

  const forced = await settingsRequest(get('/api/whatsapp/settings'), {
    ...context,
    env: { WHATSAPP_SEND_FORCE_OFF: '1' },
  });
  const forcedJson = await forced.json();
  assert.equal(forcedJson.sendEnabled, false);
  assert.equal(forcedJson.forceOff, true);
});

test('send approve issues a token; send dry-runs a receipt without calling Meta', async (t) => {
  const { context } = setup(t);
  const account = (
    await (
      await accountsRequest(
        post('/api/whatsapp/accounts', { phoneNumberId: 'pn1', tokenSecret: 'WATOK' }),
        context,
      )
    ).json()
  ).account;
  await optinRequest(
    post('/api/whatsapp/optin', { phone: '+15551234567', action: 'opt_in' }),
    context,
  );
  // Open the session window with an inbound row.
  const { createWhatsAppStore } = await import('../lib/whatsapp/store.ts');
  const store = createWhatsAppStore(context.db);
  store.recordMessage('u1', {
    accountId: account.id,
    direction: 'inbound',
    wamid: 'wamid.in.1',
    phone: '+15551234567',
  });

  const approved = await sendRequest(
    post('/api/whatsapp/send', {
      action: 'approve',
      accountId: account.id,
      to: '+15551234567',
      body: 'planned hello',
    }),
    context,
  );
  assert.equal(approved.status, 201);
  const { approvalToken } = await approved.json();
  assert.ok(approvalToken);

  const sent = await sendRequest(
    post('/api/whatsapp/send', {
      action: 'send',
      accountId: account.id,
      to: '+15551234567',
      body: 'planned hello',
      approvalToken,
    }),
    context,
  );
  const { receipt } = await sent.json();
  assert.equal(receipt.dryRun, true, 'dry-run is the default even with an approval');
  assert.equal(receipt.metaCalled, false);

  const listed = await messagesRequest(get('/api/whatsapp/messages?phone=%2B15551234567'), context);
  const messages = (await listed.json()).messages;
  assert.ok(messages.some((m) => m.status === 'dry_run'));
});
