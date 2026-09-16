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
// The root used to bounce a signed-out visitor to the sign-in form, so they
// were asked for a password before being told what this was. It serves the
// landing page now, and this assertion changes deliberately rather than being
// quietly dropped.
const landing = await fetch(base + '/', { redirect: 'manual' });
assert.equal(landing.status, 200, 'a signed-out visitor gets a page, not a redirect');
const landingHtml = await landing.text();
assert.match(landingHtml, /Start free/, 'with a way in');
assert.match(landingHtml, /bring your own key/i, 'and the free tier explained');
assert.match(await (await fetch(base + '/sign-in')).text(), /Good to have you here/);
assert.match(await (await fetch(base + '/sign-up')).text(), /Make a workspace/);
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

  // One run per conversation, so the previous one has to settle before a replay
  // is anything but a 409.
  //
  // It is cancelled rather than waited out. Waiting put the network on the
  // critical path: the run settles by failing, and it failed by reaching a real
  // provider, so the 15s window was a bet on how fast openrouter.ai answers from
  // a runner. It lost, and the next assertion reported it as "answering again is
  // accepted" — naming the primary key for what was really an unsettled run.
  // Cancelling aborts the provider call instead of racing it, and the assertion
  // below means a future stall says so itself.
  const settle = async (response) => {
    const { runId } = await response.clone().json();
    if (runId) await fetch(base + `/api/runs/${runId}/cancel`, { method: 'POST', headers });
    for (let i = 0; i < 60; i += 1) {
      const active = await (
        await fetch(base + `/api/conversations/${conversation}/runs`, { headers })
      ).json();
      if (!active.runId) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail('the previous run never settled, so the replay below cannot be read');
  };

  // 202: the reply is the run id, not the answer.
  const first = await post(turn('regen-1', 'First question'));
  assert.equal(first.status, 202);
  await settle(first);

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

  // Editing is the same replay carrying different words, so the stored question
  // has to end up as the edited one rather than the original.
  await settle(replayed);
  const edited = await post(turn('regen-1', 'A better question', 'regenerate-message'));
  assert.equal(edited.status, 202);
  const after = await stored();
  assert.equal(after.length, 1);
  assert.equal(
    after[0].parts[0].text,
    'A better question',
    'the edited words replace the original rather than being ignored',
  );
}

// A second account, created the way a stranger would, against the real routes.
//
// This is the check that the deployment can be opened to the public: registration
// works, and the account it produces cannot spend the operator's provider key,
// cannot reach a machine, and cannot see the operator's conversations. Each of
// those was true of any signed-in account before tiers existed.
if (phase === 'write') {
  const stranger = {
    email: 'stranger@example.test',
    password: 'a-long-enough-password',
    name: 'Stranger',
  };
  const created = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(stranger),
  });
  assert.equal(created.status, 200, 'registration is open');
  const strangerCookie = created.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.ok(strangerCookie, 'signing up signs you in when no address needs confirming');
  const asStranger = { cookie: strangerCookie, Origin: base, 'Content-Type': 'application/json' };

  // Super admin is the pinned owner and nobody else.
  assert.equal(
    (await fetch(base + '/api/kernel', { headers: asStranger })).status,
    403,
    'a new account is not a super admin',
  );

  // The deployment key is set in both smoke harnesses, so without this gate the
  // run below is accepted with 202 and charged to the operator.
  const keyless = await fetch(base + '/api/conversations/smoke-stranger/runs', {
    method: 'POST',
    headers: asStranger,
    body: JSON.stringify({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      freeOnly: true,
      instructions: 'Answer briefly.',
      messages: [{ id: 'stranger-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  });
  assert.equal(keyless.status, 400, 'a free account cannot spend the deployment key');

  // The control, and the whole point of the pair: the same request, the same
  // environment, the same absence of a saved key — only the account differs.
  // The operator is accepted, so the 400 above is the tier being read and not
  // some unrelated reason the run could not start.
  const asOwner = await fetch(base + '/api/conversations/smoke-owner-key/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      freeOnly: true,
      instructions: 'Answer briefly.',
      messages: [{ id: 'owner-key-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  });
  assert.equal(asOwner.status, 202, 'the operator still reaches the deployment key');

  const reason = (await keyless.json()).error;
  assert.match(reason, /own/i, 'and is told to bring its own key');
  assert.doesNotMatch(reason, /HIKMAH_PROVIDER_KEY/, 'without being shown server internals');

  // The workbench is one shared filesystem, so a shell is the operator's alone.
  assert.equal(
    (await fetch(base + '/api/workbench/ticket', { method: 'POST', headers: asStranger })).status,
    403,
    'a new account cannot open a terminal',
  );
  assert.equal(
    (await fetch(base + '/api/ssh-hosts', { headers: asStranger })).status,
    403,
    'nor add an SSH host',
  );

  // The operator's conversation reads as empty rather than as forbidden, which
  // is the route's own choice and the right one: a 403 would confirm the id
  // exists. What matters is that nothing comes back, and it is asserted against
  // a conversation that demonstrably has something in it.
  assert.equal(
    (await (await fetch(base + '/api/conversations/smoke-regen/messages', { headers })).json())
      .messages.length,
    1,
    'the operator can read their own transcript',
  );
  assert.deepEqual(
    (
      await (
        await fetch(base + '/api/conversations/smoke-regen/messages', { headers: asStranger })
      ).json()
    ).messages,
    [],
    'and a stranger reads none of it',
  );
  // That route is DELETE-only, so this is the question worth asking of it.
  assert.equal(
    (
      await fetch(base + '/api/conversations/smoke-regen', {
        method: 'DELETE',
        headers: asStranger,
      })
    ).status,
    404,
    "nor can they delete the operator's conversation",
  );
  // Their own list holds their own conversation — the refused run above created
  // one, which is right — and nothing of the operator's.
  const strangerList = (
    await (await fetch(base + '/api/conversations', { headers: asStranger })).json()
  ).conversations;
  assert.ok(
    !strangerList.some((row) => row.id === 'smoke-regen'),
    "the operator's conversation is not in a stranger's list",
  );
  assert.ok(
    strangerList.every((row) => row.id.startsWith('smoke-stranger')),
    'and everything in it is their own',
  );

  // And the operator keeps everything.
  assert.equal((await fetch(base + '/api/kernel', { headers })).status, 200);
  const ticket = await fetch(base + '/api/workbench/ticket', { method: 'POST', headers });
  assert.notEqual(ticket.status, 403, 'the operator can still open a terminal');
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
