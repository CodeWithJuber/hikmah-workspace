import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:3210';
const phase = process.argv[2] || 'write';
const cookieFile = process.env.SMOKE_COOKIE_FILE;
assert(cookieFile, 'SMOKE_COOKIE_FILE is required');
let healthy = false;
for (let attempt = 0; attempt < 45; attempt++) {
  try {
    const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
assert(healthy, 'Server must become healthy');
const health = await (await fetch(base + '/api/health')).json();
assert.equal(health.release, '9.1');
if (process.env.SMOKE_REVISION) assert.equal(health.revision, process.env.SMOKE_REVISION);
const spoof = {
  'oai-authenticated-user-id': 'owner',
  'oai-authenticated-user-email': process.env.SMOKE_EMAIL,
};
assert.equal((await fetch(base + '/api/workspace-state', { headers: spoof })).status, 401);
assert.equal((await fetch(base + '/api/secrets', { headers: spoof })).status, 401);
assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 307);
assert.match(await (await fetch(base + '/sign-in')).text(), /Good to have you here/);
let cookie;
if (phase === 'read') cookie = await readFile(cookieFile, 'utf8');
else {
  const login = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }),
  });
  assert.equal(login.status, 200, 'Owner can sign in over HTTP');
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await writeFile(cookieFile, cookie, { mode: 0o600 });
}
const headers = { cookie, Origin: base, 'Content-Type': 'application/json' };
const kernel = await fetch(base + '/api/kernel', { headers });
assert.equal(kernel.status, 200);
assert.equal((await kernel.json()).role, 'super_admin');
const context = await fetch(base + '/api/context-model', { headers });
assert.equal(context.status, 200);
const fixtureSecret = 'smoke-secret-value-private';
if (phase === 'write') {
  const secretBody = JSON.stringify({
    name: 'SMOKE_KEY',
    value: fixtureSecret,
    destination: 'provider:openrouter',
  });
  assert.equal(
    (
      await fetch(base + '/api/secrets', {
        method: 'PUT',
        headers: { ...headers, Origin: 'https://evil.test' },
        body: secretBody,
      })
    ).status,
    403,
  );
  const savedSecret = await fetch(base + '/api/secrets', {
    method: 'PUT',
    headers,
    body: secretBody,
  });
  assert.equal(savedSecret.status, 200);
  assert.ok(!(await savedSecret.text()).includes(fixtureSecret));
}
const secretList = await fetch(base + '/api/secrets', { headers });
assert.equal(secretList.status, 200);
const metadata = await secretList.json();
assert.equal(metadata.secrets[0].name, 'SMOKE_KEY');
assert.deepEqual(Object.keys(metadata.secrets[0]).sort(), ['destination', 'name', 'updatedAt']);
assert.ok(!JSON.stringify(metadata).includes(fixtureSecret));
if (phase === 'read') {
  assert.equal(
    (await fetch(base + '/api/secrets?name=SMOKE_KEY', { method: 'DELETE', headers })).status,
    200,
  );
  assert.equal((await (await fetch(base + '/api/secrets', { headers })).json()).secrets.length, 0);
}
const message = 'Memory محفوظ • '.repeat(60_000);
if (phase === 'write') {
  const session = {
    version: 1,
    additions: [],
    experimental: false,
    conversations: [
      {
        id: 'smoke',
        title: 'Persistence check',
        messages: [{ id: 'message', role: 'user', text: message }],
      },
    ],
    files: { 'main.js': 'console.log("Hikmah")' },
    knowledge: [],
    connection: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      freeOnly: true,
    },
  };
  const body = JSON.stringify({ revision: -1, session: JSON.stringify(session) });
  assert.equal(
    (
      await fetch(base + '/api/workspace-state', {
        method: 'PUT',
        headers: { ...headers, Origin: 'https://evil.test' },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + '/api/workspace-state', { method: 'PUT', headers, body })).status,
    200,
  );
  assert.equal(
    (await fetch(base + '/api/workspace-state', { method: 'PUT', headers, body })).status,
    409,
  );
}
const saved = await (await fetch(base + '/api/workspace-state', { headers })).json();
assert.equal(saved.revision, 0);
assert.equal(JSON.parse(saved.session).conversations[0].messages[0].text, message);
if (phase === 'read') {
  assert.equal(
    (await fetch(base + '/api/auth/sign-out', { method: 'POST', headers, body: '{}' })).status,
    200,
  );
  assert.equal((await fetch(base + '/api/workspace-state', { headers })).status, 401);
}
console.info(
  `HTTP smoke ${phase}: login, role, origin checks, release, saved secrets and large saved workspace passed.`,
);
