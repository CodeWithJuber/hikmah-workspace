// The terminal hands a browser socket a real shell, so these cover what the
// shell inherits and what happens when it misbehaves, not just that it starts.
// Run: node --test test/terminal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal, shellEnvironment } from '../src/terminal.ts';

/** A stand-in pty, so the env/resize/kill behaviour can be asserted exactly. */
function fakePty() {
  const calls = { written: [], resized: [], killed: 0, options: null, command: null };
  let emitData;
  let emitExit;
  const spawn = (command, _args, options) => {
    calls.command = command;
    calls.options = options;
    return {
      pid: 4242,
      onData: (fn) => {
        emitData = fn;
      },
      onExit: (fn) => {
        emitExit = fn;
      },
      write: (data) => calls.written.push(data),
      resize: (cols, rows) => calls.resized.push([cols, rows]),
      kill: () => {
        calls.killed += 1;
      },
    };
  };
  return { spawn, calls, data: (d) => emitData(d), exit: (c) => emitExit({ exitCode: c }) };
}

const sink = { onData: () => {}, onExit: () => {} };

test('the shell inherits only what it needs, not whatever the service holds', () => {
  // A shell that can read the token can mint its own tickets, and one that can
  // read a vault key can decrypt the owner's saved secrets. The allowlist is
  // what stops a variable added later from silently reaching a prompt.
  const env = shellEnvironment({
    HIKMAH_WORKBENCH_TOKEN: 'secret',
    HIKMAH_VAULT_KEY: 'secret',
    BETTER_AUTH_SECRET: 'secret',
    SOME_FUTURE_CREDENTIAL: 'secret',
    PATH: '/usr/bin',
    HOME: '/home/node',
    LC_ALL: 'C.UTF-8',
  });
  assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'HOME', 'LC_ALL', 'PATH', 'TERM']);
  assert.equal(env.PATH, '/usr/bin', 'the shell is still usable');
  assert.equal(env.HOME, '/home/node');
});

test('TERM is set so full-screen programs can draw', () => {
  assert.equal(shellEnvironment({}).TERM, 'xterm-256color');
  assert.equal(shellEnvironment({ TERM: 'dumb' }).TERM, 'dumb', 'an explicit TERM wins');
});

test('output reaches the caller and input reaches the shell', () => {
  const pty = fakePty();
  const seen = [];
  const session = createTerminal({
    ...sink,
    cwd: '/tmp',
    spawn: pty.spawn,
    onData: (d) => seen.push(d),
  });
  pty.data('hello');
  session.write('ls\r');
  assert.deepEqual(seen, ['hello']);
  assert.deepEqual(pty.calls.written, ['ls\r']);
  assert.equal(session.pid, 4242);
});

test('a nonsense size is clamped rather than passed to the ioctl', () => {
  // A zero-column resize makes the pty call fail and can leave the shell wedged.
  const pty = fakePty();
  const session = createTerminal({ ...sink, cwd: '/tmp', spawn: pty.spawn });
  session.resize(0, 0);
  session.resize(100_000, 100_000);
  session.resize(120, 40);
  assert.deepEqual(pty.calls.resized, [
    [80, 24],
    [500, 300],
    [120, 40],
  ]);
});

test('a program printing without pause is cut off instead of filling memory', () => {
  const pty = fakePty();
  const seen = [];
  const session = createTerminal({
    ...sink,
    cwd: '/tmp',
    spawn: pty.spawn,
    onData: (d) => seen.push(d),
  });
  pty.data('x'.repeat(2_000_000));
  assert.match(seen.at(-1), /printed too fast/);
  assert.equal(pty.calls.killed, 1, 'the runaway shell is stopped, not just muted');
  void session;
});

test('writing and resizing after exit does nothing', () => {
  const pty = fakePty();
  const session = createTerminal({ ...sink, cwd: '/tmp', spawn: pty.spawn });
  pty.exit(0);
  session.write('ls');
  session.resize(80, 24);
  session.kill();
  assert.deepEqual(pty.calls.written, []);
  assert.deepEqual(pty.calls.resized, []);
  assert.equal(pty.calls.killed, 0, 'a shell that already exited is not killed again');
});

test('the exit code reaches the caller so the panel can say what happened', () => {
  const pty = fakePty();
  let code;
  createTerminal({ ...sink, cwd: '/tmp', spawn: pty.spawn, onExit: (c) => (code = c) });
  pty.exit(127);
  assert.equal(code, 127);
});

test('a real shell runs a command and exits', async () => {
  // The fake covers the wiring; this proves the pty binding itself works on
  // this platform, which is where the prebuild question actually bites.
  const output = [];
  const exit = new Promise((resolve) => {
    const session = createTerminal({
      cwd: process.cwd(),
      shell: '/bin/sh',
      onData: (d) => output.push(d),
      onExit: resolve,
    });
    session.write('echo workbench-ok; exit\r');
  });
  const code = await exit;
  assert.equal(code, 0);
  assert.match(output.join(''), /workbench-ok/);
});
