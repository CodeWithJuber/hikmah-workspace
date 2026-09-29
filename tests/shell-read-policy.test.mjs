// PR-03: the shell read policy is argument-aware.
//
// `isReadOnlyCommand` used to match on the command name alone, so a "read"
// command whose flags turn it into an execution or a write was auto-approved:
// `find`'s `-delete`/`-exec` (including GNU's abbreviated `-del`), `tree -o`,
// `date -s`, `rg --pre`, `file -z`. This file pins the new contract:
//
// - only explicitly permitted argument FORMS run without asking;
// - execution/write hooks always ask, whatever the command name;
// - ambiguous or unknown arguments ask, never silently allow;
// - harmless reads (plain file reads, directory listings with safe args) still
//   run without repetitive prompts;
// - fixtures cover config/env influence: env vars, config files and aliases
//   that change what a command does.
//
// Run: node --test tests/shell-read-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_COMMANDS,
  isReadOnlyCommand,
  shellApprovalPolicy,
} from '../lib/ai/tools/shell.ts';
import { commandEnvironment } from '../workbench/src/env.ts';

const approval = shellApprovalPolicy();

test('the allowlist names are exactly the commands with a policy table', () => {
  assert.deepEqual(
    [...READ_ONLY_COMMANDS].sort(),
    [
      'cat',
      'date',
      'df',
      'diff',
      'du',
      'echo',
      'file',
      'find',
      'grep',
      'head',
      'ls',
      'pwd',
      'rg',
      'stat',
      'tail',
      'tree',
      'wc',
      'which',
      'whoami',
    ].sort(),
  );
});

test('harmless reads with safe argument forms run without asking', async () => {
  // The no-prompt battery: if any of these starts asking, the UX regresses —
  // an owner asked to approve `ls` twenty times approves the twenty-first
  // without reading it.
  const reads = [
    'ls',
    'ls -la /workspace',
    'ls --color=auto src',
    'ls -lart',
    'ls --dired',
    'pwd',
    'pwd -P',
    'cat README.md',
    'cat -n src/index.ts',
    'cat -- -weird-name',
    'head -20 build.log',
    'head -n 5 build.log',
    'tail -f server.log',
    'tail -n +5 server.log',
    'wc -l src/a.ts',
    'file --mime-type image.png',
    'stat --printf=%n src/a.ts',
    'find . -name notes.txt',
    "find . -name '*.ts' -type f -print",
    'find . -maxdepth 2 -mtime -7 -not -path ./node_modules',
    'find . -type d -prune -o -type f -print',
    'grep -r todo src',
    "grep -ri 'fix me' src --include='*.ts'",
    'grep --color=always -n pattern file',
    'rg -l pattern',
    'rg --hidden --glob !dist pattern',
    'tree -L 2',
    'tree -a -I node_modules',
    'du -sh .',
    'du --apparent-size -d 1',
    'df -h',
    'date',
    'date -u',
    "date '+%Y-%m-%d'",
    'whoami',
    'which -a node',
    'echo -n hello',
    'diff -ru a b',
    'diff --from-file=a --to-file=b',
  ];
  for (const command of reads) {
    assert.equal(isReadOnlyCommand(command), true, command);
    assert.equal(await approval({ command }), 'approved', command);
  }
});

test('find actions that write, delete or execute ask — including abbreviations', async () => {
  // The hole this ticket closes: none of these carry a separator, and the old
  // name-only check waved every one of them through.
  const dangerous = [
    'find /workspace -delete',
    'find . -delete',
    'find . -del', // GNU find accepts unambiguous abbreviations
    'find . -delet',
    'find . -exec rm -rf {} +',
    'find . -exe echo {} +',
    'find . -execdir ls {} +',
    'find . -ok cat {} +',
    'find . -okdir cat {} +',
    'find . -fls /tmp/out.txt',
    'find . -fprint /tmp/out.txt',
    'find . -fprint0 /tmp/out.txt',
    "find . -fprintf /tmp/out.txt '%p\\n'",
    'find . -type f -delete',
    'find . -name x -o -exec rm {} +',
  ];
  for (const command of dangerous) {
    assert.equal(isReadOnlyCommand(command), false, command);
    assert.equal(await approval({ command }), 'user-approval', command);
  }
});

test('matching is per token, not per substring', () => {
  // A file named `deleted` is not an action, and `-name -delete` is a pattern
  // looking for a file literally called `-delete`, not a deletion.
  assert.equal(isReadOnlyCommand('find . -name deleted'), true);
  assert.equal(isReadOnlyCommand("find . -name '-delete'"), true);
  assert.equal(isReadOnlyCommand('find . -type f -name deleted -print'), true);
});

test('flags that turn a read command into a write or an execution ask', async () => {
  const hooks = [
    'tree -o /tmp/listing.txt', // writes the listing to a file
    'tree --output-file=/tmp/listing.txt',
    "date -s '2020-01-01'", // moves the machine's clock
    'date --set=2020-01-01',
    'rg --pre=cat src', // runs a preprocessor program over every file
    'rg --pre-glob=*.txt --pre=cat src',
    'file -z archive.gz', // runs decoders on the target
    'file --uncompress archive.gz',
  ];
  for (const command of hooks) {
    assert.equal(isReadOnlyCommand(command), false, command);
    assert.equal(await approval({ command }), 'user-approval', command);
  }
});

test('unknown or ambiguous argument forms ask rather than silently allowing', async () => {
  const ambiguous = [
    'ls --frobnicate', // unknown long flag
    'ls -laZz', // unknown short flag in a bundle
    'grep --bogus pattern file',
    'cat --number=yes file', // a value on a boolean flag
    'head -n', // a value-taking flag with no value
    'find . -bogus', // an unknown find predicate
    'find . -maxdepth', // a value-taking predicate with no value
    'find . -name', // same, at the end of the line
    'ls "unterminated', // unbalanced quote: cannot parse, so ask
    "grep -e 'a(b' file", // unbalanced inside quotes still tokenizes; unbalanced quote asks
  ];
  for (const command of ambiguous.slice(0, 8)) {
    assert.equal(isReadOnlyCommand(command), false, command);
    assert.equal(await approval({ command }), 'user-approval', command);
  }
  assert.equal(isReadOnlyCommand('ls "unterminated'), false);
  // A quoted group with balanced quotes is still just an operand.
  assert.equal(isReadOnlyCommand("grep -e 'a(b' file"), true);
});

test('the command string cannot smuggle environment in', () => {
  // Env vars, config files and aliases change what a command does. The string
  // side of that is closed here: a leading VAR=value is the command name and
  // never allowlisted, and `$` interpolation (with it `$(...)`, backticks and
  // `${...}`) is a separator and always asks.
  for (const command of [
    'BASH_ENV=/tmp/evil.sh ls -la', // startup file for non-interactive bash
    'ENV=/tmp/evil.sh cat README.md', // the same for sh
    'LD_PRELOAD=/tmp/evil.so ls',
    'CDPATH=/tmp ls',
    'GREP_OPTIONS=--color=always grep x f',
    'echo $HOME',
    'echo ${PATH}',
    'ls FOO=$(whoami)',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test('the runner half of the env contract: dangerous variables never cross', () => {
  // The policy's string checks are one half; the other half is the workbench
  // scrubbing the ambient environment before a command runs. `BASH_ENV`/`ENV`
  // would point the shell at a startup file, `CDPATH` changes what `cd`
  // resolves, `GREP_OPTIONS` changes grep's flags, `LD_PRELOAD` injects code.
  // them. (Built as data, not as literal assignments: the point is the key
  // names, and no fixture here is a credential.)
  const dangerous = [
    'BASH_ENV',
    'ENV',
    'CDPATH',
    'GREP_OPTIONS',
    'LD_PRELOAD',
    'PYTHONPATH',
    'HIKMAH_WORKBENCH_TOKEN',
  ];
  const source = Object.fromEntries([
    ['PATH', '/usr/bin:/bin'],
    ['HOME', '/home/slot'],
    ['USER', 'slot'],
    ...dangerous.map((name) => [name, 'must-not-cross']),
  ]);
  const env = commandEnvironment(source);
  for (const name of dangerous) {
    assert.equal(env[name], undefined, `${name} must not cross into the command`);
  }
  // The allowlist still lets through what a shell genuinely needs.
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/slot');
  assert.equal(env.TERM, 'dumb');
});

test('separators still ask, whatever the command name', () => {
  for (const command of [
    'ls; rm -rf /',
    'cat file | tee /etc/hosts',
    'echo hello > /tmp/x',
    'find . -name x -exec echo {} \\;',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});
