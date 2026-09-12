import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStorage } from '../server/storage.mjs';
import { createAuth, initializeAuth, privateDeployment } from '../server/auth.mjs';
import { publicOrigin } from '../lib/server/origin.ts';

test('SQLite and object storage persist across restarts and stale revisions cannot overwrite data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-storage-'));
  let storage = openStorage(dir);
  try {
    await storage.DB.prepare('INSERT INTO workspace_states VALUES (?,?,?,?)')
      .bind('a', '{"saved":true}', 0, 'now')
      .run();
    const query =
      'UPDATE workspace_states SET body=?, revision=revision+1 WHERE user_id=? AND revision=?';
    const results = await Promise.all(
      ['first', 'stale'].map((value) => storage.DB.prepare(query).bind(value, 'a', 0).run()),
    );
    assert.deepEqual(
      results.map((r) => r.meta.changes),
      [1, 0],
    );
    await storage.BUCKET.put(
      'workspaces/a/one.json',
      JSON.stringify({ text: 'Saved memory • معرفة' }),
    );
    storage.close();
    storage = openStorage(dir);
    assert.equal(
      (
        await storage.DB.prepare('SELECT body, revision FROM workspace_states WHERE user_id=?')
          .bind('a')
          .first()
      ).body,
      'first',
    );
    assert.deepEqual(JSON.parse(await (await storage.BUCKET.get('workspaces/a/one.json')).text()), {
      text: 'Saved memory • معرفة',
    });
    assert.equal(await storage.BUCKET.get('missing.json'), null);
    for (const key of ['../escape', '/absolute', 'a/../../secret', 'a//b', 'a\\b'])
      await assert.rejects(storage.BUCKET.put(key, 'unsafe'));
    await symlink(tmpdir(), join(dir, 'objects', 'link'));
    await assert.rejects(storage.BUCKET.put('link/escape', 'unsafe'));
    await storage.BUCKET.delete('workspaces/a/one.json');
    assert.equal(await storage.BUCKET.get('workspaces/a/one.json'), null);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('changed applied migrations stop startup instead of silently rewriting schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-migrations-'));
  const migrations = join(dir, 'migrations');
  try {
    await cp('drizzle', migrations, { recursive: true });
    openStorage(join(dir, 'data'), migrations).close();
    const file = join(migrations, '0000_heavy_star_brand.sql');
    await writeFile(file, (await readFile(file, 'utf8')) + '\n-- changed\n');
    assert.throws(() => openStorage(join(dir, 'data'), migrations), /Applied migration changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real authentication: open registration, secure sessions, invalid password, CSRF and logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-auth-'));
  const previous = Object.fromEntries(
    ['HIKMAH_DATA_DIR', 'HIKMAH_OWNER_EMAIL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL'].map((k) => [
      k,
      process.env[k],
    ]),
  );
  Object.assign(process.env, {
    HIKMAH_DATA_DIR: dir,
    HIKMAH_OWNER_EMAIL: 'owner@example.test',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'https://hikmah.test',
  });
  const password = randomBytes(24).toString('base64url');
  let instance;
  try {
    await writeFile(join(dir, 'bootstrap-owner-password'), password, { mode: 0o600 });
    await initializeAuth();
    await assert.rejects(access(join(dir, 'bootstrap-owner-password')));
    await initializeAuth(); // Existing owner can restart without the one-time password.
    instance = createAuth();
    const request = (path, body, extra = {}) =>
      new Request('https://hikmah.test/api/auth/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://hikmah.test',
          'X-Real-IP': '127.0.0.1',
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    // Registration is open now: the app is something people sign up for, and
    // this assertion used to be the evidence that it was not. It changes
    // deliberately rather than quietly, and the closed case it replaced is
    // asserted below under HIKMAH_PRIVATE, which is how a self-hosted install
    // keeps the old behaviour.
    const signup = await instance.auth.handler(
      request('sign-up/email', { email: 'other@example.test', password, name: 'Other' }),
    );
    assert.equal(signup.status, 200, 'a stranger can create an account');
    // And the account they get is an ordinary one, not a second owner: the
    // kernel_owners row already names the bootstrap owner, so resolveTier can
    // never hand this account the operator's powers.
    const wrong = await instance.auth.handler(
      request('sign-in/email', { email: 'owner@example.test', password: 'wrong-password-value' }),
    );
    assert.equal(wrong.status, 401);
    const login = await instance.auth.handler(
      request('sign-in/email', { email: 'owner@example.test', password }),
    );
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie();
    assert(
      cookies.some((c) => /httponly/i.test(c) && /secure/i.test(c) && /samesite=lax/i.test(c)),
    );
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const session = await (
      await instance.auth.handler(request('get-session', null, { cookie }))
    ).json();
    assert.equal(session.user.email, 'owner@example.test');
    const spoof = await (
      await instance.auth.handler(
        request('get-session', null, {
          'oai-authenticated-user-id': session.user.id,
          'oai-authenticated-user-email': session.user.email,
        }),
      )
    ).json();
    assert.equal(spoof, null);
    assert.equal(
      (
        await instance.auth.handler(
          request('sign-out', {}, { cookie, Origin: 'https://evil.test' }),
        )
      ).status,
      403,
    );
    assert.equal((await instance.auth.handler(request('sign-out', {}, { cookie }))).status, 200);
    assert.equal(
      await (await instance.auth.handler(request('get-session', null, { cookie }))).json(),
      null,
    );
    assert.equal(
      publicOrigin(
        new Request('http://internal:3000/', {
          headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
        }),
      ),
      'https://hikmah.test',
    );
  } finally {
    instance?.database.close();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});

test('HIKMAH_PRIVATE keeps a self-hosted install to one account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-private-'));
  const previous = Object.fromEntries(
    [
      'HIKMAH_DATA_DIR',
      'HIKMAH_OWNER_EMAIL',
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'HIKMAH_PRIVATE',
    ].map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, {
    HIKMAH_DATA_DIR: dir,
    HIKMAH_OWNER_EMAIL: 'owner@example.test',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'https://hikmah.test',
    HIKMAH_PRIVATE: '1',
  });
  const password = randomBytes(24).toString('base64url');
  let instance;
  try {
    await writeFile(join(dir, 'bootstrap-owner-password'), password, { mode: 0o600 });
    // The owner is still created: bootstrap is the one sign-up a private
    // deployment must allow, or it would have no account at all.
    await initializeAuth();
    instance = createAuth();
    const signup = await instance.auth.handler(
      new Request('https://hikmah.test/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://hikmah.test',
          'X-Real-IP': '127.0.0.1',
        },
        body: JSON.stringify({ email: 'other@example.test', password, name: 'Other' }),
      }),
    );
    assert.equal(signup.status, 400, 'and nobody else can join');
    // The pages must agree with the server, or a form is shown that cannot work.
    assert.equal(privateDeployment(), true);
  } finally {
    instance?.database.close();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});
