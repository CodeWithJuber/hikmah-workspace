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
// The run worker is started from instrumentation.ts, which only runs if that
// file was traced into the standalone build. Assert it here rather than
// discovering after a deploy that runs queue up and nothing drives them.
assert(health.worker, 'Health must report the run worker');
assert.equal(health.worker.started, true, 'The run worker must be running');
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
// The composer inlines an attachment as a data URL, so a message body is now
// bounded by whatever someone attached. Without a cap the whole thing would be
// read into memory, parsed and written to a row before anyone noticed; refuse
// it at the door instead.
if (phase === 'write') {
  const oversize = JSON.stringify({
    messages: [
      {
        id: 'big',
        role: 'user',
        parts: [{ type: 'text', text: 'x'.repeat(33 * 1024 * 1024) }],
      },
    ],
  });
  const refused = await fetch(base + '/api/conversations/smoke-big/runs', {
    method: 'POST',
    headers,
    body: oversize,
  });
  assert.equal(refused.status, 413, 'an oversize message body is refused');
  // And the refusal must not have created the conversation on the way in.
  const after = await fetch(base + '/api/conversations/smoke-big/messages', { headers });
  assert.deepEqual((await after.json()).messages, []);
}

// Answering again replays a message that is already a row. Appending it a
// second time hit the messages primary key, so the route failed outside any
// handler and the owner was told only "The run could not be started". The turn
// has to be truncated back to that message instead.
if (phase === 'write') {
  const conversation = 'smoke-regen';
  const turn = (id, text, trigger) => ({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    freeOnly: true,
    instructions: 'Answer briefly.',
    trigger,
    messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }],
  });
  const post = (body) =>
    fetch(base + `/api/conversations/${conversation}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const stored = async () =>
    (await (await fetch(base + `/api/conversations/${conversation}/messages`, { headers })).json())
      .messages;

  // 202: the reply is the run id, not the answer.
  assert.equal((await post(turn('regen-1', 'First question'))).status, 202);

  // One run per conversation, so the first has to settle before the replay is
  // anything but a 409. There is no provider reachable here, so it fails within
  // a moment; the point of the wait is determinism, not patience.
  for (let i = 0; i < 60; i += 1) {
    const active = await (
      await fetch(base + `/api/conversations/${conversation}/runs`, { headers })
    ).json();
    if (!active.runId) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const replayed = await post(turn('regen-1', 'First question', 'regenerate-message'));
  assert.equal(replayed.status, 202, 'answering again is accepted, not a primary-key failure');
  const messages = await stored();
  assert.equal(messages.length, 1, 'the replayed turn replaces its old self rather than doubling');
  assert.equal(messages[0].id, 'regen-1');

  // Without the trigger the same message is a duplicate, and that is a refusal
  // the transport can read rather than an empty 500.
  const duplicate = await post(turn('regen-1', 'First question'));
  assert.equal(duplicate.status, 409, 'a repeated message id is refused, not crashed on');
  assert.equal((await stored()).length, 1);
}

// The JavaScript sandbox is a pre-built ES module served as a static asset.
// It is built during `npm run build` and copied into the image, and if either
// step is ever dropped the symptom is not a failed build — it is every code run
// failing in production, which is exactly how the last one went unnoticed.
const worker = await fetch(base + '/sandbox-worker.js');
assert.equal(worker.status, 200, 'the JavaScript sandbox worker is served');
const workerSource = await worker.text();
assert.ok(workerSource.length > 100_000, 'the runtime is bundled into it');
assert.ok(
  !/importScripts\s*\(/.test(workerSource),
  'importScripts means a classic worker, which cannot load this runtime',
);

console.info(
  `HTTP smoke ${phase}: login, role, origin checks, release, saved secrets, body caps, sandbox worker and large saved workspace passed.`,
);
