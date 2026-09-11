// The app and the workbench agree on a frame format across a package boundary
// neither side can import across. These tests drive the app's parser with bytes
// the workbench itself produced, so a change to either end fails here.
// Run: node --test tests/ssh-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INLINE_OUTPUT, foldFrames } from '../lib/ssh/frames.ts';
import { WorkbenchUnavailable, sshExecStream, workbenchConfig } from '../lib/ssh/client.ts';
import { runFrames } from '../workbench/src/runs.ts';

const request = {
  host: {
    id: 'h1',
    host: '10.0.0.5',
    port: 22,
    username: 'deploy',
    credential: { type: 'password', password: 'secret' },
    fingerprint: 'a'.repeat(64),
  },
  command: 'uptime',
};

const config = { url: 'http://workbench:3001', token: 'w'.repeat(48) };

/** Serve an SSE body the workbench would have produced for these frames. */
function serving(frames, { status = 200 } = {}) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (status !== 200)
      return new Response(JSON.stringify({ error: 'Send a command to run.' }), { status });
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, seen };
}

const drain = async (generator) => {
  const frames = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
};

test('a deployment without a workbench says so instead of failing obscurely', () => {
  assert.throws(() => workbenchConfig({}), WorkbenchUnavailable);
  assert.throws(
    () =>
      workbenchConfig({
        HIKMAH_WORKBENCH_URL: 'http://workbench:3001',
        HIKMAH_WORKBENCH_TOKEN: 'short',
      }),
    WorkbenchUnavailable,
  );
  const resolved = workbenchConfig({
    HIKMAH_WORKBENCH_URL: 'http://workbench:3001/',
    HIKMAH_WORKBENCH_TOKEN: 'w'.repeat(48),
  });
  assert.equal(resolved.url, 'http://workbench:3001', 'a trailing slash would double the path');
});

test('the shared token authenticates the call and the credential travels in the body', async () => {
  const { fetch, seen } = serving([
    { type: 'exit', exitCode: 0, truncated: false, fingerprint: 'f' },
  ]);
  await drain(sshExecStream(request, { config, fetch }));
  assert.equal(seen[0].url, 'http://workbench:3001/runs');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${config.token}`);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.tool, 'ssh_exec');
  assert.equal(body.host.credential.password, 'secret');
});

test('frames the workbench produced are parsed by the app unchanged', async () => {
  // The two sides live in packages that cannot import each other, so this is
  // the only place the formats are actually compared.
  const produced = [];
  const parsed = {
    tool: 'ssh_exec',
    command: 'uptime',
    timeoutMs: 5_000,
    host: { ...request.host, fingerprint: undefined },
  };
  const exec = async (host, command, options) => {
    options.onOutput('stdout', 'load average: 0.1\n');
    options.onOutput('stderr', 'a warning\n');
    return { stdout: '', stderr: '', exitCode: 3, truncated: true, fingerprint: 'seen-fp' };
  };
  for await (const frame of runFrames(parsed, { exec })) produced.push(frame);

  const { fetch } = serving(produced);
  const received = await drain(sshExecStream(request, { config, fetch }));
  assert.deepEqual(received, produced);

  const folded = foldFrames(received);
  assert.equal(folded.stdout, 'load average: 0.1\n');
  assert.equal(folded.stderr, 'a warning\n');
  assert.equal(folded.exitCode, 3);
  assert.equal(folded.truncated, true);
  assert.equal(folded.fingerprint, 'seen-fp');
});

test('a frame split across two network chunks is still read once, whole', async () => {
  // SSE arrives in whatever pieces the socket gives; a parser that assumed one
  // frame per chunk would drop output under exactly the load that matters.
  const frames = [
    { type: 'output', stream: 'stdout', data: 'first half second half' },
    { type: 'exit', exitCode: 0, truncated: false, fingerprint: 'f' },
  ];
  const encoded = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  const fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(encoded);
          // Split mid-frame on purpose.
          controller.enqueue(bytes.slice(0, 12));
          controller.enqueue(bytes.slice(12, 40));
          controller.enqueue(bytes.slice(40));
          controller.close();
        },
      }),
      { status: 200 },
    );
  assert.deepEqual(await drain(sshExecStream(request, { config, fetch })), frames);
});

test('a refusal from the workbench keeps its explanation', async () => {
  const { fetch } = serving([], { status: 400 });
  await assert.rejects(
    drain(sshExecStream(request, { config, fetch })),
    (error) => error instanceof WorkbenchUnavailable && /command/.test(error.message),
  );
});

test('an unreachable workbench is named as such, not as a command failure', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    drain(sshExecStream(request, { config, fetch })),
    (error) => error instanceof WorkbenchUnavailable && /could not be reached/.test(error.message),
  );
});

test('cancelling propagates rather than being reported as an outage', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = async (_url, init) => {
    init.signal?.throwIfAborted();
    throw new Error('unreachable');
  };
  await assert.rejects(
    drain(sshExecStream(request, { config, fetch, signal: controller.signal })),
    (error) => error.name === 'AbortError',
  );
});

test('output beyond the inline cap is dropped and flagged, not returned whole', () => {
  const folded = foldFrames([
    { type: 'output', stream: 'stdout', data: 'x'.repeat(MAX_INLINE_OUTPUT * 2) },
    { type: 'exit', exitCode: 0, truncated: false, fingerprint: 'f' },
  ]);
  assert.equal(folded.stdout.length, MAX_INLINE_OUTPUT);
  assert.equal(folded.truncated, true);
});

test('output already received survives a later failure', () => {
  // A timeout after ten useful lines should show those lines, not an empty error.
  const folded = foldFrames([
    { type: 'output', stream: 'stdout', data: 'got this far' },
    { type: 'error', error: 'The command reached its time limit and was stopped.' },
  ]);
  assert.equal(folded.stdout, 'got this far');
  assert.match(folded.error, /time limit/);
  assert.equal(folded.exitCode, null);
});

test('a changed host key is marked, not folded into an ordinary error', () => {
  const folded = foldFrames([
    { type: 'error', error: 'The host key has changed.', kind: 'host-key-mismatch' },
  ]);
  assert.equal(folded.hostKeyChanged, true);
});
