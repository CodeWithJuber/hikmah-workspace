// The run endpoint executes commands on the owner's servers. These cover what
// it refuses to accept, that output arrives during the command rather than
// after it, and that a dropped connection actually stops the command.
// Run: node --test test/runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  RunRequestError,
  parseRunRequest,
  runFrames,
} from '../src/runs.ts';
import { HostKeyMismatch } from '../src/ssh.ts';
import { resetSessions } from '../src/runs.ts';

/** An account key, in the shape the app mints (an HMAC, base64url). Local runs
 * are refused without one now: there is no shared slot to fall back to. */
const USER = 'u'.repeat(32);
const OTHER_USER = 'v'.repeat(32);
import { createWorkbench } from '../src/server.ts';

const TOKEN = 'r'.repeat(48);

const body = (overrides = {}) => ({
  tool: 'ssh_exec',
  command: 'uptime',
  host: {
    id: 'h1',
    host: '10.0.0.5',
    port: 22,
    username: 'deploy',
    credential: { type: 'password', password: 'secret' },
    fingerprint: 'a'.repeat(64),
  },
  ...overrides,
});

test('a well-formed request is accepted with a default timeout', () => {
  const parsed = parseRunRequest(body());
  assert.equal(parsed.command, 'uptime');
  assert.equal(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(parsed.host.fingerprint, 'a'.repeat(64));
});

test('only the tools this service implements are accepted', () => {
  for (const tool of [undefined, 'bash', 'ssh', '']) {
    assert.throws(() => parseRunRequest(body({ tool })), RunRequestError, String(tool));
  }
});

test('an incomplete host is refused rather than half-used', () => {
  // A host missing a field is the shape a redirected connection would take, so
  // nothing here is defaulted or inferred.
  const base = body().host;
  for (const field of ['id', 'host', 'username']) {
    const host = { ...base };
    delete host[field];
    assert.throws(() => parseRunRequest(body({ host })), RunRequestError, field);
  }
  assert.throws(() => parseRunRequest(body({ host: { ...base, port: 0 } })), RunRequestError);
  assert.throws(
    () => parseRunRequest(body({ host: { ...base, credential: {} } })),
    RunRequestError,
  );
});

test('a first connection without a pinned fingerprint is allowed through', () => {
  // This is how a host gets pinned at all; the app records what comes back.
  const host = { ...body().host, fingerprint: undefined };
  assert.equal(parseRunRequest(body({ host })).host.fingerprint, undefined);
});

test('an empty or oversized command is refused', () => {
  for (const command of ['', '   ', undefined, 'x'.repeat(8_001)]) {
    assert.throws(() => parseRunRequest(body({ command })), RunRequestError);
  }
});

test('a timeout must be a sane number of milliseconds', () => {
  for (const timeoutMs of [0, -1, MAX_TIMEOUT_MS + 1, 'soon', Number.NaN]) {
    assert.throws(() => parseRunRequest(body({ timeoutMs })), RunRequestError, String(timeoutMs));
  }
  assert.equal(parseRunRequest(body({ timeoutMs: 5_000 })).timeoutMs, 5_000);
});

/** A stand-in for sshExec that emits output on demand. */
function fakeExec({ chunks = [], result, error, hold } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (host, command, options) => {
      calls.push({ host, command, options });
      for (const [stream, data] of chunks) options.onOutput?.(stream, data);
      if (hold) await hold;
      if (error) throw error;
      return result ?? { stdout: '', stderr: '', exitCode: 0, truncated: false, fingerprint: 'f' };
    },
  };
}

const collect = async (request, options) => {
  const frames = [];
  for await (const frame of runFrames(request, options)) frames.push(frame);
  return frames;
};

test('output frames arrive before the exit frame, in order', async () => {
  const { exec } = fakeExec({
    chunks: [
      ['stdout', 'first'],
      ['stderr', 'warning'],
      ['stdout', 'second'],
    ],
    result: { exitCode: 0, truncated: false, fingerprint: 'fp', stdout: '', stderr: '' },
  });
  const frames = await collect(parseRunRequest(body()), { exec });
  assert.deepEqual(
    frames.map((f) => [f.type, f.stream ?? f.exitCode]),
    [
      ['output', 'stdout'],
      ['output', 'stderr'],
      ['output', 'stdout'],
      ['exit', 0],
    ],
  );
  assert.equal(frames.at(-1).fingerprint, 'fp', 'the caller needs this to pin a new host');
});

test('a non-zero exit is reported as an exit, not an error', async () => {
  // The command ran. Treating a failing command as a transport error would hide
  // the output that explains why it failed.
  const { exec } = fakeExec({
    chunks: [['stderr', 'no such file']],
    result: { exitCode: 127, truncated: false, fingerprint: 'fp', stdout: '', stderr: '' },
  });
  const frames = await collect(parseRunRequest(body()), { exec });
  assert.equal(frames.at(-1).type, 'exit');
  assert.equal(frames.at(-1).exitCode, 127);
});

test('truncated output is flagged so the caller knows something was dropped', async () => {
  const { exec } = fakeExec({
    result: { exitCode: 0, truncated: true, fingerprint: 'fp', stdout: '', stderr: '' },
  });
  const frames = await collect(parseRunRequest(body()), { exec });
  assert.equal(frames.at(-1).truncated, true);
});

test('a changed host key is reported as itself, not as a generic failure', async () => {
  // The app has to be able to tell this apart to explain it, and it must never
  // look like something worth retrying.
  const { exec } = fakeExec({ error: new HostKeyMismatch('expected-fp', 'actual-fp') });
  const frames = await collect(parseRunRequest(body()), { exec });
  assert.equal(frames.at(-1).type, 'error');
  assert.equal(frames.at(-1).kind, 'host-key-mismatch');
  assert.equal(frames.at(-1).actual, 'actual-fp');
});

test('a failure after partial output keeps the output', async () => {
  const { exec } = fakeExec({
    chunks: [['stdout', 'got this far']],
    error: new Error('The command reached its time limit and was stopped.'),
  });
  const frames = await collect(parseRunRequest(body()), { exec });
  assert.equal(frames[0].data, 'got this far');
  assert.match(frames.at(-1).error, /time limit/);
});

test('the command and host reach the connector unchanged', async () => {
  const { exec, calls } = fakeExec();
  await collect(parseRunRequest(body({ command: 'df -h', timeoutMs: 4_000 })), { exec });
  assert.equal(calls[0].command, 'df -h');
  assert.equal(calls[0].host.host, '10.0.0.5');
  assert.equal(calls[0].options.timeoutMs, 4_000);
});

/** A workspace per test file run, so local commands cannot touch the real one. */
const workspaceRoot = mkdtempSync(join(tmpdir(), 'hikmah-runs-'));

/**
 * Slots, without the uids.
 *
 * In production a slot is a real Unix user and a 0700 directory, and resolving
 * one chowns it — which needs root, which CI is not. So these tests get a slot
 * that is only a directory: the accounting (one directory per account, refused
 * without an account) is what is under test here, and the kernel half — that
 * slot A really cannot read slot B — is asserted in the container by
 * scripts/smoke-workbench.sh, where there are real users to drop to.
 */
function fakeSlots(root) {
  const seen = new Map();
  return (userKey) => {
    if (!seen.has(userKey)) {
      const index = seen.size + 1;
      const name = 'hk' + String(index).padStart(2, '0');
      const home = join(root, 'u', name);
      mkdirSync(home, { recursive: true });
      // The current uid, not a slot uid: setuid to yourself is a permitted
      // no-op, so the real spawn path — the wrapper, the cd after the drop, the
      // filtered environment — is exercised without needing root.
      seen.set(userKey, { index, name, uid: process.getuid(), gid: process.getgid(), home });
    }
    return seen.get(userKey);
  };
}

// The wrapper lives at /usr/local/bin in the image. Here it is the copy in the
// repo, which is the same file the Dockerfile installs.
process.env.HIKMAH_RUN_WRAPPER = fileURLToPath(new URL('../bin/hikmah-run', import.meta.url));

/** Start a workbench whose SSH is faked, and return how to reach it. */
async function start(t, execOptions) {
  resetSessions();
  const { exec, calls } = fakeExec(execOptions);
  const workbench = createWorkbench({
    token: TOKEN,
    appOrigin: 'https://app.test',
    workspace: workspaceRoot,
    exec,
    slots: fakeSlots(workspaceRoot),
    createTerminal: () => ({ pid: 1, write() {}, resize() {}, kill() {} }),
  });
  const port = await workbench.listen(0);
  t.after(() => workbench.close());
  return { port, calls, workbench };
}

const post = (port, payload, headers = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

/** Read an SSE body into the frames it carried. */
async function frames(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)));
}

test('a run without the shared token is refused', async (t) => {
  const { port, calls } = await start(t);
  const response = await post(port, body(), {});
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0, 'nothing may run before the token is checked');
});

test('a run streams its frames back over HTTP', async (t) => {
  const { port } = await start(t, {
    chunks: [['stdout', 'load average: 0.1']],
    result: { exitCode: 0, truncated: false, fingerprint: 'fp', stdout: '', stderr: '' },
  });
  const response = await post(port, body());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const received = await frames(response);
  assert.equal(received[0].data, 'load average: 0.1');
  assert.equal(received.at(-1).type, 'exit');
});

test('a malformed run is a 4xx, not an empty stream', async (t) => {
  const { port } = await start(t);
  const response = await post(port, body({ command: '' }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /command/);
});

test('dropping the connection stops the command', async (t) => {
  // Otherwise Stop would only stop the transcript, and the command would keep
  // running on someone's server with nobody watching.
  let released;
  const hold = new Promise((resolve) => {
    released = resolve;
  });
  const { port, calls } = await start(t, { hold });

  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body()),
    signal: controller.signal,
  }).catch(() => null);

  // Wait for the command to actually be in flight before hanging up.
  for (let attempt = 0; attempt < 50 && calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls.length, 1, 'the command should have started');
  const signal = calls[0].options.signal;
  assert.equal(signal.aborted, false, 'nothing is cancelled while the caller is still listening');

  const stopped = new Promise((resolve) =>
    signal.addEventListener('abort', resolve, { once: true }),
  );
  controller.abort();
  await Promise.race([
    stopped,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the command was never stopped')), 2_000),
    ),
  ]);
  assert.equal(signal.aborted, true);
  released();
  await pending;
});

// --- Local execution -------------------------------------------------------
// bash and sandbox_run run in this container rather than on a saved host, so
// the request shape is checked as strictly as the SSH one and the session id is
// required: without it, two conversations would share a working directory.

test('a bash request needs a command and a session', () => {
  for (const bad of [
    { tool: 'bash' },
    { tool: 'bash', sessionId: 'conv-1' },
    { tool: 'bash', sessionId: 'conv-1', command: '   ' },
    { tool: 'bash', command: 'ls' },
    { tool: 'bash', sessionId: 'has spaces', command: 'ls' },
    { tool: 'bash', sessionId: 'conv-1', command: 'x'.repeat(8_001) },
  ]) {
    assert.throws(() => parseRunRequest(bad), RunRequestError, JSON.stringify(bad));
  }
  const parsed = parseRunRequest({
    tool: 'bash',
    sessionId: 'conv-1',
    userKey: USER,
    command: 'ls',
  });
  assert.equal(parsed.tool, 'bash');
  assert.equal(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('a bash request may ask for a fresh working directory', () => {
  const parsed = parseRunRequest({
    tool: 'bash',
    sessionId: 'conv-1',
    userKey: USER,
    command: 'pwd',
    reset: true,
  });
  assert.equal(parsed.reset, true);
});

test('sandbox_run only accepts a language the image actually has', () => {
  for (const language of [undefined, 'ruby', 'perl', 'bash', '']) {
    assert.throws(
      () =>
        parseRunRequest({
          tool: 'sandbox_run',
          sessionId: 'c',
          userKey: USER,
          language,
          code: 'x',
        }),
      RunRequestError,
      String(language),
    );
  }
  for (const language of ['python', 'node']) {
    assert.equal(
      parseRunRequest({ tool: 'sandbox_run', sessionId: 'c', userKey: USER, language, code: 'x' })
        .language,
      language,
    );
  }
});

test('sandbox_run needs code, and not an unbounded amount of it', () => {
  for (const code of [undefined, '', '  ', 'x'.repeat(100_001)]) {
    assert.throws(
      () =>
        parseRunRequest({
          tool: 'sandbox_run',
          sessionId: 'c',
          userKey: USER,
          language: 'python',
          code,
        }),
      RunRequestError,
    );
  }
});

test('a local command streams its output and reports where it left the shell', async (t) => {
  const { port } = await start(t);
  const response = await post(port, {
    tool: 'bash',
    sessionId: 'conv-local-1',
    userKey: USER,
    command: 'echo streamed',
  });
  assert.equal(response.status, 200);
  const received = await frames(response);
  assert.match(received[0].data, /streamed/);
  const exit = received.at(-1);
  assert.equal(exit.type, 'exit');
  assert.equal(exit.exitCode, 0);
  assert.ok(exit.cwd, 'the app needs this to show where the next command runs');
});

test('a directory change survives between two requests', async (t) => {
  // The session is what makes `cd` then `ls` behave like a shell rather than
  // like two unrelated commands.
  const { port } = await start(t);
  await post(port, {
    tool: 'bash',
    sessionId: 'conv-local-2',
    userKey: USER,
    command: 'mkdir -p sub && cd sub',
  });
  const second = await frames(
    await post(port, {
      tool: 'bash',
      sessionId: 'conv-local-2',
      userKey: USER,
      command: 'pwd',
    }),
  );
  assert.match(second[0].data.trim(), /\/sub$/);
});

test('a reset sends the session back to the top of the workspace', async (t) => {
  const { port } = await start(t);
  await post(port, {
    tool: 'bash',
    sessionId: 'conv-local-3',
    userKey: USER,
    command: 'mkdir -p deep && cd deep',
  });
  const after = await frames(
    await post(port, {
      tool: 'bash',
      sessionId: 'conv-local-3',
      userKey: USER,
      command: 'pwd',
      reset: true,
    }),
  );
  assert.equal(after[0].data.trim().endsWith('/deep'), false);
});

test('a snippet runs and its output comes back', async (t) => {
  const { port } = await start(t);
  const received = await frames(
    await post(port, {
      tool: 'sandbox_run',
      sessionId: 'conv-local-4',
      userKey: USER,
      language: 'node',
      code: 'console.log(6 * 7);',
    }),
  );
  assert.match(received.map((frame) => frame.data ?? '').join(''), /42/);
  assert.equal(received.at(-1).exitCode, 0);
});

test('a local command without the shared token is refused', async (t) => {
  // The same gate as SSH: nothing runs here on an unauthenticated request.
  const { port } = await start(t);
  const response = await post(
    port,
    { tool: 'bash', sessionId: 'c', userKey: USER, command: 'echo no' },
    {},
  );
  assert.equal(response.status, 401);
});

test('a local run that names no account is refused, not given a shared slot', async (t) => {
  // The point of the whole change: there is no shared slot to fall back to, so
  // defaulting would silently re-create the one /workspace everybody shared.
  const { port } = await start(t);
  for (const body of [
    { tool: 'bash', sessionId: 'c', command: 'echo hi' },
    { tool: 'bash', sessionId: 'c', userKey: '', command: 'echo hi' },
    { tool: 'bash', sessionId: 'c', userKey: '../etc', command: 'echo hi' },
    { tool: 'sandbox_run', sessionId: 'c', language: 'node', code: 'console.log(1)' },
  ]) {
    const response = await post(port, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const { error } = await response.json();
    assert.match(error, /which account/, 'and says what is missing');
  }
});

test('two accounts in the same conversation do not share a directory', async (t) => {
  // `sessionId` is the app's conversation id. It used to be the only key, so
  // two accounts using one id landed on one remembered directory.
  const { port } = await start(t);
  const mine = await frames(
    await post(port, { tool: 'bash', sessionId: 'shared-id', userKey: USER, command: 'pwd' }),
  );
  const theirs = await frames(
    await post(port, { tool: 'bash', sessionId: 'shared-id', userKey: OTHER_USER, command: 'pwd' }),
  );
  assert.notEqual(mine[0].data.trim(), theirs[0].data.trim(), 'one id, two directories');
});

test('a command starts in its own slot, not at the top of the volume', async (t) => {
  const { port } = await start(t);
  const received = await frames(
    await post(port, { tool: 'bash', sessionId: 'conv-slot', userKey: USER, command: 'pwd' }),
  );
  assert.match(received[0].data.trim(), /\/u\/hk\d\d$/, 'the slot directory is where it begins');
});

test('a command cannot be left standing in another slot', async (t) => {
  // The cwd comes back from the shell itself, so `cd` somewhere else used to
  // move the session there for good. It is clamped to the slot now.
  const { port } = await start(t);
  const escaped = await frames(
    await post(port, {
      tool: 'bash',
      sessionId: 'conv-escape',
      userKey: USER,
      command: 'cd / && pwd',
    }),
  );
  assert.equal(escaped.at(-1).cwd.endsWith('/'), false, 'not left at the filesystem root');
  const next = await frames(
    await post(port, { tool: 'bash', sessionId: 'conv-escape', userKey: USER, command: 'pwd' }),
  );
  assert.match(next[0].data.trim(), /\/u\/hk\d\d$/, 'the next command is back in the slot');
});

test('a snippet is written inside the slot, not a shared .runs directory', async (t) => {
  // /workspace/.runs held every account's programs, readable by all of them.
  const { port } = await start(t);
  const received = await frames(
    await post(port, {
      tool: 'sandbox_run',
      sessionId: 'conv-snippet-slot',
      userKey: USER,
      language: 'node',
      code: 'console.log(import.meta.url);',
    }),
  );
  const printed = received.map((frame) => frame.data ?? '').join('');
  assert.match(printed, /\/u\/hk\d\d\/\.runs\//, 'the program lives in its own slot');
});
