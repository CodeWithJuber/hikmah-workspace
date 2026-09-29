// PR-16: security posture at the auth API boundary.
//
// Drives the real better-auth handler (the same one
// app/api/auth/[...all]/route.ts delegates to) against a throwaway sqlite
// database, and asserts the four ticket areas:
//
//   1. rate limiting — /sign-in/email, /callback/* and /refresh-token are
//      bounded per IP; brute force cannot run free;
//   2. session expiry — an expired session cannot be reused, active sessions
//      refresh on the updateAge schedule, and sign-out deletes the session;
//   3. OAuth hardening — callbackURL allowlisted against trustedOrigins,
//      PKCE (S256 code_challenge) on the Google authorization URL, tampered
//      or replayed state fails closed with no provider details;
//   4. no credential writes — passwords, the auth secret and the OAuth
//      client secret never reach logs or error responses.
//
// Run: node --test tests/auth-security.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth, initializeAuth } from '../server/auth.mjs';

const ORIGIN = 'https://hikmah.test';
const ENV_KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'HIKMAH_DATA_DIR',
  'HIKMAH_OWNER_EMAIL',
  'HIKMAH_PRIVATE',
  'HIKMAH_PUBLIC',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

/** A throwaway deployment: temp dir, migrated auth database, real handler. */
async function setupAuth({ ip = '10.20.0.1', withGoogle = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-authsec-'));
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: 'auth-security-test-secret-0123456789abcdef',
    BETTER_AUTH_URL: ORIGIN,
    HIKMAH_DATA_DIR: dir,
    HIKMAH_OWNER_EMAIL: 'owner@example.test',
    // Open registration: tests create their users through sign-up, the same
    // way a public deployment does.
    HIKMAH_PRIVATE: '0',
    ...(withGoogle
      ? { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret' }
      : {}),
  });
  const password = randomBytes(24).toString('base64url');
  await writeFile(join(dir, 'bootstrap-owner-password'), password, { mode: 0o600 });
  await initializeAuth();
  const instance = createAuth();
  const request = (path, body, extra = {}) =>
    new Request(`${ORIGIN}/api/auth/${path}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        'X-Real-IP': ip,
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const close = async () => {
    instance.database.close();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  };
  return { instance, request, close, password };
}

async function createUser(ctx, email) {
  const password = randomBytes(24).toString('base64url');
  const signup = await ctx.instance.auth.handler(
    ctx.request('sign-up/email', { email, password, name: email }),
  );
  assert.equal(signup.status, 200, 'sign-up works in the test deployment');
  const login = await ctx.instance.auth.handler(ctx.request('sign-in/email', { email, password }));
  assert.equal(login.status, 200, 'sign-in works in the test deployment');
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.match(cookie, /(?:__Secure-)?better-auth\.session_token=/, 'a session cookie is set');
  // The get-session body carries the raw session token (the cookie holds it
  // signed with the auth secret), so tests can address the exact row without
  // parsing the cookie format.
  const me = await (
    await ctx.instance.auth.handler(ctx.request('get-session', undefined, { cookie }))
  ).json();
  assert.ok(me?.session?.token, 'the session is readable back');
  return { email, password, cookie, token: me.session.token };
}

function sessionRow(ctx, token) {
  return ctx.instance.database.prepare('SELECT token FROM session WHERE token = ?').get(token);
}

/** Capture everything the process writes through console.* while fn runs. */
function captureConsole() {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  for (const m of methods)
    console[m] = (...args) => {
      lines.push(
        args
          .map((a) => {
            try {
              return typeof a === 'string' ? a : JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' '),
      );
    };
  return {
    lines,
    restore() {
      for (const m of methods) console[m] = originals[m];
    },
  };
}

test('rate limit: the OAuth callback is bounded per IP', async () => {
  const ctx = await setupAuth({ ip: '10.20.0.11', withGoogle: true });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.instance.auth.handler(
        ctx.request(`callback/google?state=bogus-state-${i}&code=x`),
      );
      statuses.push(res.status);
    }
    assert.deepEqual(
      statuses,
      [302, 302, 302, 302, 302, 429],
      'five code-exchange attempts pass, the sixth is refused',
    );
    const retry = await ctx.instance.auth.handler(
      ctx.request('callback/google?state=bogus-state-6&code=x'),
    );
    assert.ok(retry.headers.get('x-retry-after'), 'the refusal names when to come back');
  } finally {
    await ctx.close();
  }
});

test('rate limit: the provider token refresh is bounded per IP', async () => {
  const ctx = await setupAuth({ ip: '10.20.0.12' });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.instance.auth.handler(
        ctx.request('refresh-token', { userId: 'no-such-user' }),
      );
      statuses.push(res.status);
    }
    assert.deepEqual(
      statuses,
      [400, 400, 400, 400, 400, 429],
      'five refresh attempts pass validation, the sixth is refused',
    );
  } finally {
    await ctx.close();
  }
});

test('rate limit: the existing sign-in bound still holds', async () => {
  const ctx = await setupAuth({ ip: '10.20.0.13' });
  try {
    const email = 'brute@example.test';
    await createUser(ctx, email);
    const statuses = [];
    // createUser already spent one sign-in/email attempt on the correct login.
    for (let i = 0; i < 6; i++) {
      const res = await ctx.instance.auth.handler(
        ctx.request('sign-in/email', { email, password: 'wrong-password-value' }),
      );
      statuses.push(res.status);
    }
    assert.deepEqual(
      statuses,
      [401, 401, 401, 401, 429, 429],
      'four wrong passwords pass, then the bucket is spent',
    );
  } finally {
    await ctx.close();
  }
});

test('session expiry: an expired session cannot be reused', async () => {
  const ctx = await setupAuth();
  try {
    const { cookie, token } = await createUser(ctx, 'expiry@example.test');
    ctx.instance.database
      .prepare('UPDATE session SET expiresAt = ? WHERE token = ?')
      .run('2001-01-01T00:00:00.000Z', token);
    const res = await ctx.instance.auth.handler(ctx.request('get-session', undefined, { cookie }));
    assert.equal(await res.json(), null, 'the expired session is not honoured');
    assert.equal(
      sessionRow(ctx, token),
      undefined,
      'the expired row is cleaned up, not left to be replayed',
    );
  } finally {
    await ctx.close();
  }
});

test('session expiry: an active session refreshes on the updateAge schedule', async () => {
  const ctx = await setupAuth();
  try {
    const { cookie, token } = await createUser(ctx, 'refresh@example.test');
    const before = ctx.instance.database
      .prepare('SELECT expiresAt FROM session WHERE token = ?')
      .get(token).expiresAt;
    // Age the session one day: past updateAge (24h) but inside expiresIn (7d).
    const aged = new Date(Date.now() - 25 * 3600 * 1000 + 7 * 24 * 3600 * 1000).toISOString();
    assert.ok(new Date(aged) < new Date(before), 'the aged session is older than the fresh one');
    ctx.instance.database
      .prepare('UPDATE session SET expiresAt = ?, updatedAt = ? WHERE token = ?')
      .run(aged, new Date(Date.now() - 25 * 3600 * 1000).toISOString(), token);
    const res = await ctx.instance.auth.handler(ctx.request('get-session', undefined, { cookie }));
    const body = await res.json();
    assert.ok(body?.session, 'the session is still valid');
    assert.ok(
      new Date(body.session.expiresAt) > new Date(aged),
      'activity pushed the expiry out again',
    );
    const again = await (
      await ctx.instance.auth.handler(ctx.request('get-session', undefined, { cookie }))
    ).json();
    assert.ok(again?.session, 'the refreshed session stays valid on the same cookie');
    assert.ok(
      new Date(again.session.expiresAt) > new Date(aged),
      'the extension is durable, not a one-off response',
    );
  } finally {
    await ctx.close();
  }
});

test('session expiry: sign-out invalidates the session server-side', async () => {
  const ctx = await setupAuth();
  try {
    const { cookie, token } = await createUser(ctx, 'logout@example.test');
    const out = await ctx.instance.auth.handler(ctx.request('sign-out', {}, { cookie }));
    assert.equal(out.status, 200);
    assert.equal(sessionRow(ctx, token), undefined, 'the session row is gone, not just the cookie');
    const res = await ctx.instance.auth.handler(ctx.request('get-session', undefined, { cookie }));
    assert.equal(await res.json(), null, 'the old cookie buys nothing');
  } finally {
    await ctx.close();
  }
});

test('oauth: a foreign callbackURL is rejected at the allowlist', async () => {
  const ctx = await setupAuth({ withGoogle: true });
  try {
    const res = await ctx.instance.auth.handler(
      ctx.request('sign-in/social', { provider: 'google', callbackURL: 'https://evil.test/x' }),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'INVALID_CALLBACK_URL');
  } finally {
    await ctx.close();
  }
});

test('oauth: the authorization URL uses PKCE', async () => {
  const ctx = await setupAuth({ withGoogle: true });
  try {
    const res = await ctx.instance.auth.handler(
      ctx.request('sign-in/social', { provider: 'google', callbackURL: '/' }),
    );
    assert.equal(res.status, 200);
    const { url } = await res.json();
    assert.match(url, /code_challenge=/, 'a challenge is sent to the provider');
    assert.match(url, /code_challenge_method=S256/, 'the challenge is S256, not plain');
    assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/, 'it is Google');
  } finally {
    await ctx.close();
  }
});

test('oauth: tampered state fails closed with no provider detail', async () => {
  const ctx = await setupAuth({ withGoogle: true });
  try {
    const res = await ctx.instance.auth.handler(
      ctx.request('callback/google?state=tampered-state-value&code=whatever'),
    );
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.equal(
      location,
      `${ORIGIN}/api/auth/error?error=state_mismatch`,
      'a fixed error code, no provider internals in the URL',
    );
    assert.ok(
      !res.headers.getSetCookie().some((c) => /(?:__Secure-)?better-auth\.session_token=/.test(c)),
      'no session is minted on a failed callback',
    );
  } finally {
    await ctx.close();
  }
});

test('oauth: a replayed callback fails identically, never half-succeeding', async () => {
  const ctx = await setupAuth({ withGoogle: true });
  try {
    const first = await ctx.instance.auth.handler(
      ctx.request('callback/google?state=replayed-state&code=whatever'),
    );
    const second = await ctx.instance.auth.handler(
      ctx.request('callback/google?state=replayed-state&code=whatever'),
    );
    assert.equal(first.status, 302);
    assert.equal(second.status, 302);
    assert.equal(
      second.headers.get('location'),
      first.headers.get('location'),
      'the replay lands on the same error, with nothing created in between',
    );
  } finally {
    await ctx.close();
  }
});

test('no credential writes: failures never log or return secrets', async () => {
  const ctx = await setupAuth({ withGoogle: true });
  const { lines, restore } = captureConsole();
  try {
    const forbidden = [
      process.env.BETTER_AUTH_SECRET,
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    ];
    // A sign-up, a wrong-password sign-in, and a bogus OAuth callback: every
    // failure surface the ticket names, with the secret material in play.
    await ctx.instance.auth.handler(
      ctx.request('sign-up/email', {
        email: 'quiet@example.test',
        password: ctx.password,
        name: 'Quiet',
      }),
    );
    const wrong = await ctx.instance.auth.handler(
      ctx.request('sign-in/email', {
        email: 'quiet@example.test',
        password: 'wrong-password-value',
      }),
    );
    assert.equal(wrong.status, 401);
    const body = await wrong.text();
    assert.ok(!body.includes('wrong-password-value'), 'the 401 body never echoes the password');
    await ctx.instance.auth.handler(ctx.request('callback/google?state=nope&code=nope'));
    forbidden.push('wrong-password-value', ctx.password);
    for (const secret of forbidden) {
      assert.ok(
        !lines.some((line) => line.includes(secret)),
        `no log line carries a credential (${secret.slice(0, 8)}…)`,
      );
    }
  } finally {
    restore();
    await ctx.close();
  }
});
