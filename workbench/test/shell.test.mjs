// These run real commands, because the point of the module is that a command
// actually runs and reports back honestly. The container is the sandbox; what
// is tested here is the accounting around it — the cwd that carries, the caps,
// the timeout, and where output goes when there is too much of it.
// Run: node --test test/shell.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_INLINE_OUTPUT,
  ShellError,
  containPath,
  createSessions,
  runCommand,
  runSnippet,
} from '../src/shell.ts';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hikmah-shell-'));
  t.after(() => {});
  return root;
}

const run = (session, command, root, options = {}) =>
  runCommand(session, command, { workspace: root, ...options });

test('a command runs and its output and exit code come back', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'echo hello', root);
  assert.equal(result.stdout, 'hello\n', 'the command\u2019s own newline is its output');
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, false);
});

test('a failing command reports its code rather than throwing', async (t) => {
  // The output is what explains the failure; an exception would discard it.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'echo oops >&2; exit 3', root);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /oops/);
});

test('the shell is a shell: pipes, redirects and && all work', async (t) => {
  // The model writes shell. Re-implementing one badly would be the alternative.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'printf "b\\na\\n" | sort | tr -d "\\n" && echo " ok"', root);
  assert.equal(result.stdout, 'ab ok\n');
});

test('a directory change carries to the next command in the session', async (t) => {
  // This is why sessions exist at all: cd then ls is two calls, not one.
  const root = await workspace(t);
  const sessions = createSessions(root);
  const session = sessions.for('conv-1');
  await run(session, 'mkdir -p project/src', root);
  await run(session, 'cd project/src', root);
  const result = await run(session, 'pwd', root);
  assert.match(result.stdout.trim(), /project\/src$/);
  assert.match(session.cwd, /project\/src$/);
});

test('two conversations do not share a working directory', async (t) => {
  const root = await workspace(t);
  const sessions = createSessions(root);
  await run(sessions.for('conv-1'), 'mkdir -p a && cd a', root);
  const other = await run(sessions.for('conv-2'), 'pwd', root);
  assert.equal(other.stdout.trim(), root, 'a second conversation starts at the top');
});

test('resetting a session forgets where it was', async (t) => {
  const root = await workspace(t);
  const sessions = createSessions(root);
  await run(sessions.for('conv-1'), 'mkdir -p a && cd a', root);
  sessions.reset('conv-1');
  const result = await run(sessions.for('conv-1'), 'pwd', root);
  assert.equal(result.stdout.trim(), root);
});

test('a command that leaves the workspace does not strand the session there', async (t) => {
  // Not a security boundary — the container is that — but a stray `cd /` would
  // otherwise make every later command in the conversation run from the root.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  await run(session, 'cd /', root);
  assert.equal(session.cwd, root);
});

test('containment accepts the workspace and anything under it', () => {
  assert.equal(containPath('/workspace', '/workspace'), '/workspace');
  assert.equal(containPath('/workspace', '/workspace/a/b'), '/workspace/a/b');
  assert.equal(containPath('/workspace', '/etc'), '/workspace');
  assert.equal(containPath('/workspace', '/workspace/../etc'), '/workspace');
  assert.equal(
    containPath('/workspace', '/workspace-other'),
    '/workspace',
    'a prefix is not a parent',
  );
});

test('the cwd marker never shows up in the output', async (t) => {
  // It is an implementation detail of getting the directory back; a user seeing
  // it would be seeing a bug.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'echo visible', root);
  assert.equal(result.stdout, 'visible\n');
  assert.equal(result.stdout.includes('hikmah_cwd'), false);
});

test('output streams during the command rather than only at the end', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const seen = [];
  await run(session, 'echo one; echo two', root, {
    onOutput: (stream, chunk) => seen.push([stream, chunk]),
  });
  assert.ok(
    seen.some(([, chunk]) => chunk.includes('one')),
    'the transcript fills in live',
  );
});

test('very long output is capped, flagged, and kept in a log', async (t) => {
  // Dropping it entirely would mean the assistant cannot go and look.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(
    session,
    `head -c ${MAX_INLINE_OUTPUT * 2} /dev/zero | tr "\\0" "x"`,
    root,
  );
  assert.ok(result.stdout.length <= MAX_INLINE_OUTPUT);
  assert.equal(result.truncated, true);
  assert.ok(result.logPath, 'the caller is told where the rest went');
  const log = await readFile(result.logPath, 'utf8');
  assert.ok(log.length > MAX_INLINE_OUTPUT);
});

test('a command that outruns its limit is stopped and said to be', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'sleep 30', root, { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('a command that reads stdin fails rather than hanging until the deadline', async (t) => {
  // Nothing is ever typed into these; an open stdin would make `cat` look like
  // a slow command instead of a mistake.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'cat', root, { timeoutMs: 5_000 });
  assert.notEqual(result.timedOut, true);
});

test('cancelling stops the command', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const controller = new AbortController();
  const pending = run(session, 'sleep 30', root, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.timedOut, true);
});

test('a default timeout applies when none is given', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await run(session, 'echo quick', root);
  assert.equal(result.exitCode, 0);
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

test('a python snippet runs without the model quoting anything', async (t) => {
  // The code goes in on a file precisely so quoting is not the model's problem.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await runSnippet(session, 'python', 'print("it\'s \\"quoted\\"")', {
    workspace: root,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /it's "quoted"/);
});

test('a node snippet runs too', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await runSnippet(session, 'node', 'console.log(1 + 1);', { workspace: root });
  assert.equal(result.stdout, '2\n');
});

test('a snippet that throws reports the error, not a crash', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  const result = await runSnippet(session, 'python', 'raise SystemExit("bad")', {
    workspace: root,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /bad/);
});

test('an unknown language is refused by name', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  await assert.rejects(
    runSnippet(session, 'ruby', 'puts 1', { workspace: root }),
    (error) => error instanceof ShellError && /python or node/.test(error.message),
  );
});

test('snippets are written inside the workspace, not somewhere the owner cannot see', async (t) => {
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  await runSnippet(session, 'node', 'console.log("x");', { workspace: root });
  const files = await readdir(join(root, '.runs'));
  assert.ok(files.some((name) => name.endsWith('.mjs')));
});

test('a command inherits only what a shell needs, never the service’s token', async (t) => {
  // The human terminal has filtered this since it was written (`src/terminal.ts`,
  // asserted by name in `terminal.test.mjs`). The model's path did not:
  // `runCommand` spawned with `{ ...process.env }`, so the whole environment —
  // `HIKMAH_WORKBENCH_TOKEN` included — reached every command. And `env` was on
  // the app's auto-approved list, so printing it needed nobody's say-so.
  //
  // That token is the workbench's entire authentication: anything holding it can
  // POST a command to /runs. It has no business being readable by the commands
  // it authorises.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  process.env.HIKMAH_WORKBENCH_TOKEN = 'token-that-must-not-leak';
  process.env.HIKMAH_VAULT_KEY = 'key-that-must-not-leak';
  t.after(() => {
    delete process.env.HIKMAH_WORKBENCH_TOKEN;
    delete process.env.HIKMAH_VAULT_KEY;
  });

  const result = await run(session, 'env', root);
  assert.doesNotMatch(result.stdout, /HIKMAH_/, 'no HIKMAH_* variable reaches a command');
  assert.doesNotMatch(result.stdout, /must-not-leak/, 'and neither do their values');
  // The filter has to leave a working shell behind, or it just moves the bug.
  assert.match(result.stdout, /(^|\n)PATH=/, 'PATH still crosses, or nothing runs');
});

test('a snippet is spawned through the same filter as a command', async (t) => {
  // sandbox_run reaches the same spawn, so a filter applied only to `bash` would
  // leave `sandbox_run` printing the token with a two-line Python program.
  const root = await workspace(t);
  const session = createSessions(root).for('conv-1');
  process.env.HIKMAH_WORKBENCH_TOKEN = 'token-that-must-not-leak';
  t.after(() => {
    delete process.env.HIKMAH_WORKBENCH_TOKEN;
  });
  const result = await runSnippet(
    session,
    'python',
    'import os; print("SEEN", [k for k in os.environ if k.startswith("HIKMAH_")])',
    { workspace: root },
  );
  assert.match(result.stdout, /SEEN \[\]/, 'a snippet sees no HIKMAH_* either');
});
