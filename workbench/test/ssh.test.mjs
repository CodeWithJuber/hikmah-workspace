// SSH against a real in-process ssh2 server. The host-key pin is the property
// that matters most: without it, ssh2 accepts any key and the connection can be
// silently redirected.
// Run: node --test test/ssh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { HostKeyMismatch, MAX_INLINE_OUTPUT, sshExec } from '../src/ssh.ts';

/**
 * One host key for the whole file, generated rather than committed.
 *
 * ssh2's own generateKeyPairSync emits a private key its own parseKey rejects
 * roughly once in three hundred ("Malformed OpenSSH private key"). Such a key
 * would fail in the Server constructor too, so it is discarded and regenerated
 * rather than retried at the test level — the key really is unusable.
 */
function generateHostKey() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const key = utils.generateKeyPairSync('ed25519').private;
    const parsed = utils.parseKey(key);
    if (typeof parsed?.getPublicSSH === 'function')
      return { key, fingerprint: createHash('sha256').update(parsed.getPublicSSH()).digest('hex') };
  }
  throw new Error('ssh2 could not generate a key it can parse.');
}

const hostKey = generateHostKey();

/** Start a server that answers one command, and return how to reach it. */
async function startServer({ stdout = 'ok\n', stderr = '', exitCode = 0 } = {}) {
  const { key, fingerprint } = hostKey;

  const server = new Server({ hostKeys: [key] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(stdout.replaceAll('{cmd}', info.command));
          if (stderr) stream.stderr.write(stderr);
          stream.exit(exitCode);
          stream.end();
        });
      });
    });
    // A client that refuses the host key drops the connection; that is normal.
    client.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, fingerprint };
}

const host = (port, fingerprint) => ({
  id: 'h1',
  host: '127.0.0.1',
  port,
  username: 'tester',
  credential: { type: 'password', password: 'unused' },
  fingerprint,
});

test('a command runs and its output and exit code come back', async (t) => {
  const { server, port, fingerprint } = await startServer({ stdout: 'ran: {cmd}\n', exitCode: 0 });
  t.after(() => server.close());
  const result = await sshExec(host(port, fingerprint), 'uptime');
  assert.match(result.stdout, /ran: uptime/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, false);
});

test('stderr and a non-zero exit are reported, not swallowed', async (t) => {
  const { server, port, fingerprint } = await startServer({
    stdout: '',
    stderr: 'not found\n',
    exitCode: 127,
  });
  t.after(() => server.close());
  const result = await sshExec(host(port, fingerprint), 'nope');
  assert.match(result.stderr, /not found/);
  assert.equal(result.exitCode, 127);
});

test('a changed host key refuses the connection', async (t) => {
  // The pin is the defence against a redirected connection, so a mismatch must
  // fail closed rather than warn and continue.
  const { server, port } = await startServer();
  t.after(() => server.close());
  await assert.rejects(
    sshExec(host(port, 'a'.repeat(64)), 'uptime'),
    (error) => error instanceof HostKeyMismatch,
  );
});

test('a first connection reports the fingerprint so it can be pinned', async (t) => {
  const { server, port, fingerprint } = await startServer();
  t.after(() => server.close());
  const result = await sshExec({ ...host(port, undefined), fingerprint: undefined }, 'uptime');
  assert.equal(result.fingerprint, fingerprint, 'the caller needs this to pin the host');
});

test('output streams as it arrives rather than only at the end', async (t) => {
  const { server, port, fingerprint } = await startServer({ stdout: 'live output\n' });
  t.after(() => server.close());
  const seen = [];
  await sshExec(host(port, fingerprint), 'echo', {
    onOutput: (stream, chunk) => seen.push([stream, chunk]),
  });
  assert.ok(
    seen.some(([stream, chunk]) => stream === 'stdout' && chunk.includes('live output')),
    'the transcript should fill in during the command, not after it',
  );
});

test('very long output is capped inline and flagged', async (t) => {
  const { server, port, fingerprint } = await startServer({
    stdout: 'x'.repeat(MAX_INLINE_OUTPUT * 2),
  });
  t.after(() => server.close());
  const result = await sshExec(host(port, fingerprint), 'cat big');
  assert.ok(result.stdout.length <= MAX_INLINE_OUTPUT);
  assert.equal(result.truncated, true, 'the caller must know output was dropped');
});

test('a command can be stopped', async (t) => {
  const { server, port, fingerprint } = await startServer();
  t.after(() => server.close());
  const controller = new AbortController();
  const pending = sshExec(host(port, fingerprint), 'sleep 60', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

test('a connection that never completes hits its time limit', async (t) => {
  // A black-holed port: connect never resolves and never errors.
  await assert.rejects(
    sshExec({ ...host(1, 'a'.repeat(64)), host: '203.0.113.1' }, 'uptime', { timeoutMs: 150 }),
    /time limit|ECONN|EHOSTUNREACH|ENETUNREACH|timed out/i,
  );
});
