// The run endpoint executes commands on the owner's servers. These cover what
// it refuses to accept, that output arrives during the command rather than
// after it, and that a dropped connection actually stops the command.
// Run: node --test test/runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  RunRequestError,
  parseRunRequest,
  runFrames,
} from '../src/runs.ts';
import { HostKeyMismatch } from '../src/ssh.ts';
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

/** Start a workbench whose SSH is faked, and return how to reach it. */
async function start(t, execOptions) {
  const { exec, calls } = fakeExec(execOptions);
  const workbench = createWorkbench({
    token: TOKEN,
    appOrigin: 'https://app.test',
    workspace: '/tmp',
    exec,
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
