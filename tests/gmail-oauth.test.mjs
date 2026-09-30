// The OAuth flow against a stubbed network: the consent URL, the code
// exchange, and token refresh. No request here may reach Google.
// Run: node --test tests/gmail-oauth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessToken,
  authorizationUrl,
  exchangeCodeForTokens,
  oauthClientFromEnv,
} from '../lib/gmail/oauth.ts';
import { GMAIL_SCOPE_COMPOSE, GMAIL_SCOPE_READONLY } from '../lib/gmail/scopes.ts';

const client = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://app.test/api/gmail/oauth/callback',
};

/** A fetch stub keyed by URL prefix. Records every call. */
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { fetchImpl, calls };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function memoryTokens(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    saved: map,
    save: async (name, tokens) => void map.set(name, tokens),
    load: async (name) => map.get(name) ?? null,
    remove: async (name) => void map.delete(name),
  };
}

test('oauthClientFromEnv refuses without credentials, naming what to set', () => {
  assert.throws(() => oauthClientFromEnv({}, 'https://app.test'), /GMAIL_CLIENT_ID/);
  assert.throws(
    () => oauthClientFromEnv({ GOOGLE_CLIENT_ID: 'x' }, 'https://app.test'),
    /GMAIL_CLIENT_SECRET/,
  );
  const viaSigninClient = oauthClientFromEnv(
    { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' },
    'https://app.test/',
  );
  assert.equal(
    viaSigninClient.redirectUri,
    'https://app.test/api/gmail/oauth/callback',
    'falls back to the sign-in client',
  );
  const dedicated = oauthClientFromEnv(
    {
      GMAIL_CLIENT_ID: 'g',
      GMAIL_CLIENT_SECRET: 's',
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'y',
    },
    'https://app.test',
  );
  assert.equal(dedicated.clientId, 'g', 'the Gmail client wins when set');
});

test('the consent URL asks for offline access and the narrow scopes', () => {
  const url = new URL(authorizationUrl(client, 'read', 'state-1'));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), client.redirectUri);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.ok(url.searchParams.get('scope')?.includes(GMAIL_SCOPE_READONLY));
  assert.ok(!url.searchParams.get('scope')?.includes(GMAIL_SCOPE_COMPOSE));

  const sendUrl = new URL(authorizationUrl(client, 'send', 'state-2'));
  assert.ok(sendUrl.searchParams.get('scope')?.includes(GMAIL_SCOPE_COMPOSE));
});

test('the code exchange stores tokens and reports the granted scopes', async () => {
  const { fetchImpl, calls } = stubFetch([
    [
      'https://oauth2.googleapis.com/token',
      async (url, init) => {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('code'), 'the-code');
        assert.equal(body.get('redirect_uri'), client.redirectUri);
        return json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: `${GMAIL_SCOPE_READONLY}`,
        });
      },
    ],
    [
      'https://www.googleapis.com/gmail/v1/users/me/profile',
      async (url, init) => {
        assert.equal(init.headers.authorization, 'Bearer at-1');
        return json({ emailAddress: 'me@example.com' });
      },
    ],
  ]);
  const tokens = memoryTokens();
  const result = await exchangeCodeForTokens(
    fetchImpl,
    client,
    tokens,
    'GMAIL_OAUTH_X',
    'the-code',
  );
  assert.equal(result.email, 'me@example.com');
  assert.deepEqual(result.grantedScopes, [GMAIL_SCOPE_READONLY]);
  const saved = tokens.saved.get('GMAIL_OAUTH_X');
  assert.equal(saved.accessToken, 'at-1');
  assert.equal(saved.refreshToken, 'rt-1');
  assert.ok(saved.expiresAt > Date.now());
  assert.equal(calls.length, 2, 'token exchange plus profile, nothing else');
});

test('a callback without a refresh token is refused, not half-connected', async () => {
  const { fetchImpl } = stubFetch([
    ['https://oauth2.googleapis.com/token', async () => json({ access_token: 'at-1' })],
  ]);
  await assert.rejects(
    exchangeCodeForTokens(fetchImpl, client, memoryTokens(), 'GMAIL_OAUTH_X', 'code'),
    /refresh token/,
  );
});

test('a fresh stored token is returned without touching the network', async () => {
  const { fetchImpl, calls } = stubFetch([]);
  const tokens = memoryTokens({
    GMAIL_OAUTH_X: {
      accessToken: 'at-live',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  assert.equal(await accessToken(fetchImpl, client, tokens, 'GMAIL_OAUTH_X'), 'at-live');
  assert.equal(calls.length, 0);
});

test('a stale token is refreshed and the new bundle is saved', async () => {
  const { fetchImpl } = stubFetch([
    [
      'https://oauth2.googleapis.com/token',
      async (url, init) => {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'rt-old');
        return json({ access_token: 'at-new', expires_in: 3600 });
      },
    ],
  ]);
  const tokens = memoryTokens({
    GMAIL_OAUTH_X: { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 },
  });
  assert.equal(await accessToken(fetchImpl, client, tokens, 'GMAIL_OAUTH_X'), 'at-new');
  const saved = tokens.saved.get('GMAIL_OAUTH_X');
  assert.equal(saved.accessToken, 'at-new');
  assert.equal(saved.refreshToken, 'rt-old', 'kept when Google withholds a new one');
});

test('an unknown account has no tokens to load', async () => {
  const { fetchImpl } = stubFetch([]);
  await assert.rejects(
    accessToken(fetchImpl, client, memoryTokens(), 'GMAIL_OAUTH_NOPE'),
    /not connected/,
  );
});
