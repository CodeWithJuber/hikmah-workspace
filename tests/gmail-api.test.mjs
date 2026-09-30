// The Gmail request handlers end to end against a stubbed network: account
// selection, scope gating, the approval gate, the send flag and idempotent
// send. The fetch stub throws on any unexpected URL, so a test that would
// reach Google fails loudly instead of sending real mail.
// Run: node --test tests/gmail-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  accountsRequest,
  draftsRequest,
  messagesRequest,
  oauthRequest,
  sendRequest,
  settingsRequest,
} from '../lib/gmail/api.ts';
import { createGmailStore } from '../lib/gmail/store.ts';
import {
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_READONLY,
  GMAIL_SCOPE_SEND,
} from '../lib/gmail/scopes.ts';

const ORIGIN = 'https://app.test';
const OAUTH_CLIENT = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: `${ORIGIN}/api/gmail/oauth/callback`,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0034_gmail.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  const newId = () => `id${++counter}`;
  const store = createGmailStore(db, { newId });

  const sentCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const auth = init.headers?.authorization ?? '';
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('code'), 'auth-code');
        return json({
          access_token: 'at-new',
          refresh_token: 'rt-new',
          expires_in: 3600,
          scope: options.grantScopes ?? GMAIL_SCOPE_READONLY,
        });
      }
      return json({ access_token: 'at-refreshed', expires_in: 3600 });
    }
    if (url.startsWith('https://www.googleapis.com/gmail/v1/users/me/profile'))
      return json({ emailAddress: 'me@example.com' });
    if (url === 'https://www.googleapis.com/gmail/v1/users/me/messages/send') {
      sentCalls.push({ url, init, auth });
      return json({ id: `gmail-${sentCalls.length}`, threadId: 'thread-1' });
    }
    if (url.startsWith('https://www.googleapis.com/gmail/v1/users/me/messages/')) {
      assert.ok(
        auth === 'Bearer tok-a' || auth === 'Bearer tok-b',
        `the request used a connected account's token, got ${auth}`,
      );
      const id = url.split('/messages/')[1].split('?')[0];
      return json({
        id,
        threadId: 'thread-1',
        snippet: 'snippet',
        payload: { headers: [{ name: 'Subject', value: `Subject of ${id}` }] },
      });
    }
    if (url.startsWith('https://www.googleapis.com/gmail/v1/users/me/messages?')) {
      assert.ok(
        auth === 'Bearer tok-a' || auth === 'Bearer tok-b',
        `account token used, got ${auth}`,
      );
      return json({ messages: [{ id: 'm1', threadId: 't1' }] });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const tokenData = new Map();
  const tokens = {
    save: async (name, bundle) => void tokenData.set(name, bundle),
    load: async (name) => tokenData.get(name) ?? null,
    remove: async (name) => void tokenData.delete(name),
    data: tokenData,
  };

  const context = (userId, env = {}) => ({
    db,
    userId,
    fetchImpl,
    tokens,
    oauthClient: OAUTH_CLIENT,
    env,
    newId,
  });

  /** Connect an account directly in the store, with live tokens. */
  const connect = (userId, email, scopes, tokenName) => {
    const account = store.upsertAccount(userId, email, {
      displayName: null,
      scopes,
      tokenSecret: tokenName,
    });
    tokenData.set(tokenName, {
      accessToken: tokenName === 'GMAIL_OAUTH_A' ? 'tok-a' : 'tok-b',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    });
    return account;
  };

  const call = (handler, method, path, userId, body, env) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
      context(userId, env),
    );

  return { store, connect, call, context, sentCalls, tokenData, newId };
}

test('anonymous callers get nothing', async (t) => {
  const { call } = setup(t);
  assert.equal((await call(accountsRequest, 'GET', '/api/gmail/accounts', null)).status, 401);
  assert.equal(
    (await call(messagesRequest, 'GET', '/api/gmail/messages?accountId=x', null)).status,
    401,
  );
  assert.equal(
    (await call(sendRequest, 'POST', '/api/gmail/send', null, { action: 'approve' })).status,
    401,
  );
});

test('reading without naming an account is refused: no silent default', async (t) => {
  const { call, connect } = setup(t);
  connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  const response = await call(messagesRequest, 'GET', '/api/gmail/messages', 'u1');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Choose one of your connected Gmail accounts/);
});

test('reading an unknown or another-owner account is refused', async (t) => {
  const { call, connect } = setup(t);
  connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  assert.equal(
    (await call(messagesRequest, 'GET', '/api/gmail/messages?accountId=nope', 'u1')).status,
    404,
  );
  assert.equal(
    (await call(messagesRequest, 'GET', '/api/gmail/messages?accountId=nope', 'u2')).status,
    404,
  );
});

test('a send-only account cannot read: the grant is the boundary', async (t) => {
  const { call, connect } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_COMPOSE} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  const response = await call(
    messagesRequest,
    'GET',
    `/api/gmail/messages?accountId=${account.id}`,
    'u1',
  );
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /sending only/);
});

test('listing and reading use the named account, never a default', async (t) => {
  const { call, connect } = setup(t);
  const a = connect('u1', 'a@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  const b = connect('u1', 'b@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_B');
  const listed = await (
    await call(messagesRequest, 'GET', `/api/gmail/messages?accountId=${a.id}`, 'u1')
  ).json();
  assert.deepEqual(listed.messages, [{ id: 'm1', threadId: 't1' }]);
  const read = await (
    await call(messagesRequest, 'GET', `/api/gmail/messages?accountId=${b.id}&id=m9`, 'u1')
  ).json();
  assert.equal(read.message.subject, 'Subject of m9');
  // The stub asserts each call carried the right account's bearer token.
});

test('the accounts list shows grants, never the token secret', async (t) => {
  const { call, connect } = setup(t);
  connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  const body = await (await call(accountsRequest, 'GET', '/api/gmail/accounts', 'u1')).json();
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].email, 'me@example.com');
  assert.deepEqual(body.accounts[0].scopeLabels, ['Read mail']);
  assert.ok(!('tokenSecret' in body.accounts[0]), 'the secret name never leaves the server');
});

test('disconnecting removes the account and its vault tokens', async (t) => {
  const { call, connect, tokenData } = setup(t);
  const account = connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  const body = await (
    await call(accountsRequest, 'DELETE', `/api/gmail/accounts?id=${account.id}`, 'u1')
  ).json();
  assert.equal(body.accounts.length, 0);
  assert.equal(tokenData.has('GMAIL_OAUTH_A'), false, 'the OAuth secret is gone too');
});

test('drafts are local: create, list, edit, discard', async (t) => {
  const { call, connect } = setup(t);
  const account = connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  const created = await (
    await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
      accountId: account.id,
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
    })
  ).json();
  assert.ok(created.draft.id);
  const bad = await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
    accountId: account.id,
    to: [],
    body: 'b',
  });
  assert.equal(bad.status, 400);
  const listed = await (
    await call(draftsRequest, 'GET', `/api/gmail/drafts?accountId=${account.id}`, 'u1')
  ).json();
  assert.equal(listed.drafts.length, 1);
  const edited = await (
    await call(draftsRequest, 'PATCH', '/api/gmail/drafts', 'u1', {
      id: created.draft.id,
      subject: 's2',
    })
  ).json();
  assert.equal(edited.draft.subject, 's2');
  const deleted = await (
    await call(draftsRequest, 'DELETE', `/api/gmail/drafts?id=${created.draft.id}`, 'u1')
  ).json();
  assert.equal(deleted.deleted, true);
});

test('sending is refused while the switch is off', async (t) => {
  const { call, connect } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  const draft = await (
    await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
      accountId: account.id,
      to: ['a@x.com'],
      body: 'b',
    })
  ).json();
  const denied = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'approve',
    draftId: draft.draft.id,
  });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /switched off/);
});

test('the full approve-then-send flow, exactly once', async (t) => {
  const { call, connect, store, sentCalls } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  store.setSendEnabled('u1', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        subject: 's',
        body: 'b',
      })
    ).json()
  ).draft;

  const approved = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draft.id,
      idempotencyKey: 'key-1',
    })
  ).json();
  assert.ok(approved.approvalToken, 'a token is minted');
  assert.equal(approved.idempotencyKey, 'key-1');

  const noToken = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draft.id,
    idempotencyKey: 'key-1',
  });
  assert.equal(noToken.status, 403, 'no approval, no send');

  const sent = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'send',
      draftId: draft.id,
      approvalToken: approved.approvalToken,
      idempotencyKey: 'key-1',
    })
  ).json();
  assert.equal(sent.sent, true);
  assert.equal(sent.gmailMessageId, 'gmail-1');
  assert.equal(sentCalls.length, 1, 'the Gmail API saw exactly one send');
  assert.equal(store.draft(draft.id, 'u1'), undefined, 'a sent draft is gone');

  // The approval died with the send: replaying it authorizes nothing.
  const replay = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draft.id,
    approvalToken: approved.approvalToken,
    idempotencyKey: 'key-2',
  });
  assert.equal(replay.status, 404, 'the sent draft is gone, so the replay cannot proceed');
  assert.equal(sentCalls.length, 1, 'still exactly one Gmail send');

  // And a used approval on a live draft is refused too.
  const draftB = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['b@x.com'],
        body: 'b2',
      })
    ).json()
  ).draft;
  const approvedB = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draftB.id,
    })
  ).json();
  store.useApproval(approvedB.approvalToken);
  const spent = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draftB.id,
    approvalToken: approvedB.approvalToken,
    idempotencyKey: 'key-3',
  });
  assert.equal(spent.status, 403, 'a used approval authorizes nothing');
  assert.equal(sentCalls.length, 1, 'still exactly one Gmail send');
});

test('a retry with the same idempotency key returns the stored result, no second mail', async (t) => {
  const { call, connect, store, sentCalls } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  store.setSendEnabled('u1', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'b',
      })
    ).json()
  ).draft;
  const approved = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draft.id,
      idempotencyKey: 'retry-key',
    })
  ).json();
  await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draft.id,
    approvalToken: approved.approvalToken,
    idempotencyKey: 'retry-key',
  });
  // Simulate the client never seeing the response: same key, fresh approval.
  const draft2 = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'b',
      })
    ).json()
  ).draft;
  const approved2 = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draft2.id,
      idempotencyKey: 'retry-key',
    })
  ).json();
  const retry = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'send',
      draftId: draft2.id,
      approvalToken: approved2.approvalToken,
      idempotencyKey: 'retry-key',
    })
  ).json();
  assert.equal(retry.duplicate, true, 'the retry returns the first result');
  assert.equal(retry.gmailMessageId, 'gmail-1');
  assert.equal(sentCalls.length, 1, 'the Gmail API was called once');
});

test('editing the draft after approval voids the approval', async (t) => {
  const { call, connect, store } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  store.setSendEnabled('u1', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'original',
      })
    ).json()
  ).draft;
  const approved = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draft.id,
    })
  ).json();
  await call(draftsRequest, 'PATCH', '/api/gmail/drafts', 'u1', { id: draft.id, body: 'edited' });
  const tampered = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draft.id,
    approvalToken: approved.approvalToken,
    idempotencyKey: 'tamper-key',
  });
  assert.equal(tampered.status, 403);
  assert.match((await tampered.json()).error, /draft changed/);
});

test('an expired approval and another owner’s approval authorize nothing', async (t) => {
  const { call, connect, store } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  store.setSendEnabled('u1', true);
  store.setSendEnabled('u2', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'b',
      })
    ).json()
  ).draft;
  // An approval that expired before it was used.
  const expired = store.approveDraft(draft.id, 'u1', { ttlMs: -1000 });
  const gone = await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
    action: 'send',
    draftId: draft.id,
    approvalToken: expired.token,
    idempotencyKey: 'expired-key',
  });
  assert.equal(gone.status, 403);
  // Another owner cannot spend u1's approval, and cannot see u1's draft.
  const fresh = store.approveDraft(draft.id, 'u1', {});
  const foreign = await call(sendRequest, 'POST', '/api/gmail/send', 'u2', {
    action: 'send',
    draftId: draft.id,
    approvalToken: fresh.token,
    idempotencyKey: 'foreign-key',
  });
  assert.equal(foreign.status, 404, 'u2 cannot even see the draft');
});

test('sending from a read-only account is refused even with an approval', async (t) => {
  const { call, connect, store } = setup(t);
  const account = connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  store.setSendEnabled('u1', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'b',
      })
    ).json()
  ).draft;
  const approved = await (
    await call(sendRequest, 'POST', '/api/gmail/send', 'u1', {
      action: 'approve',
      draftId: draft.id,
    })
  ).json();
  // The approve step itself refuses: a read-only grant cannot approve a send.
  assert.ok(approved.error, 'approve refuses on a read-only account');
  assert.match(approved.error, /reading only/);
});

test('the deployment force-off switch beats the owner switch', async (t) => {
  const { call, connect, store } = setup(t);
  const account = connect(
    'u1',
    'me@example.com',
    `${GMAIL_SCOPE_READONLY} ${GMAIL_SCOPE_SEND}`,
    'GMAIL_OAUTH_A',
  );
  store.setSendEnabled('u1', true);
  const draft = (
    await (
      await call(draftsRequest, 'POST', '/api/gmail/drafts', 'u1', {
        accountId: account.id,
        to: ['a@x.com'],
        body: 'b',
      })
    ).json()
  ).draft;
  const denied = await call(
    sendRequest,
    'POST',
    '/api/gmail/send',
    'u1',
    { action: 'approve', draftId: draft.id },
    { GMAIL_SEND_FORCE_OFF: '1' },
  );
  assert.equal(denied.status, 403);
  const settings = await (
    await call(settingsRequest, 'GET', '/api/gmail/settings', 'u1', undefined, {
      GMAIL_SEND_FORCE_OFF: '1',
    })
  ).json();
  assert.equal(settings.sendEnabled, false);
  assert.equal(settings.forceOff, true);
});

test('the settings switch flips sending on and off', async (t) => {
  const { call } = setup(t);
  assert.equal(
    (await (await call(settingsRequest, 'GET', '/api/gmail/settings', 'u1')).json()).sendEnabled,
    false,
    'off by default',
  );
  const on = await (
    await call(settingsRequest, 'PATCH', '/api/gmail/settings', 'u1', { sendEnabled: true })
  ).json();
  assert.equal(on.sendEnabled, true);
  const bad = await call(settingsRequest, 'PATCH', '/api/gmail/settings', 'u1', {
    sendEnabled: 'yes',
  });
  assert.equal(bad.status, 400);
});

test('oauth start returns the consent URL and remembers the grant kind', async (t) => {
  const { call, store } = setup(t);
  const started = await (
    await call(oauthRequest, 'POST', '/api/gmail/oauth', 'u1', { kind: 'read' })
  ).json();
  assert.ok(started.url.includes('accounts.google.com'), 'a Google consent URL');
  assert.ok(started.url.includes(encodeURIComponent(GMAIL_SCOPE_READONLY)));
  const unknown = await call(oauthRequest, 'POST', '/api/gmail/oauth', 'u1', {
    kind: 'send',
    accountId: 'nope',
  });
  assert.equal(unknown.status, 404);
  assert.equal(store.takeOAuthState('bogus'), undefined);
});

test('oauth callback connects the account with the scopes Google granted', async (t) => {
  const { call, store, tokenData } = setup(t);
  store.saveOAuthState('state-1', 'u1', 'read');
  const response = await call(
    oauthRequest,
    'GET',
    '/api/gmail/oauth?code=auth-code&state=state-1',
    'u1',
  );
  assert.equal(response.status, 302);
  const location = response.headers.get('location') ?? '';
  assert.ok(location.includes('/connections?gmail=connected'), location);
  assert.ok(location.includes('email=me%40example.com'), location);
  const accounts = store.accounts('u1');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].scopes, GMAIL_SCOPE_READONLY, 'records what was granted');
  assert.ok(tokenData.has(accounts[0].tokenSecret), 'the token bundle is stored');
  assert.equal(store.takeOAuthState('state-1'), undefined, 'the state is spent');
});

test('oauth callback with a bad or foreign state lands on the error page', async (t) => {
  const { call, store } = setup(t);
  const bad = await call(oauthRequest, 'GET', '/api/gmail/oauth?code=x&state=nope', 'u1');
  assert.equal(bad.status, 302);
  assert.ok((bad.headers.get('location') ?? '').includes('gmail=error'));
  store.saveOAuthState('state-2', 'u1', 'read');
  const foreign = await call(oauthRequest, 'GET', '/api/gmail/oauth?code=x&state=state-2', 'u2');
  assert.ok((foreign.headers.get('location') ?? '').includes('gmail=error'));
  assert.equal(store.accounts('u2').length, 0, 'no account for the wrong owner');
});

test('an incremental send grant merges into the existing account', async (t) => {
  const { call, store, connect } = setup(t, {
    grantScopes: `${GMAIL_SCOPE_COMPOSE} ${GMAIL_SCOPE_SEND}`,
  });
  const account = connect('u1', 'me@example.com', GMAIL_SCOPE_READONLY, 'GMAIL_OAUTH_A');
  store.saveOAuthState('state-3', 'u1', 'send', account.id);
  const response = await call(
    oauthRequest,
    'GET',
    '/api/gmail/oauth?code=auth-code&state=state-3',
    'u1',
  );
  assert.ok((response.headers.get('location') ?? '').includes('gmail=connected'));
  const updated = store.account(account.id, 'u1');
  assert.ok(updated?.scopes.includes(GMAIL_SCOPE_READONLY), 'the read grant survives');
  assert.ok(updated?.scopes.includes(GMAIL_SCOPE_SEND), 'the send grant merges in');
  assert.equal(updated?.tokenSecret, 'GMAIL_OAUTH_A', 'the same vault secret is reused');
});
