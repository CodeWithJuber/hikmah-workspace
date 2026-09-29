// An approval that is remembered.
//
// Every bash, sandbox_run and ssh_exec call asked again, and the card offered
// only Allow and Don't allow, so a person starting the same preview server for
// the tenth time approved it for the tenth time. A grant now has a scope —
// this exact command, this tool in this conversation, or this tool anywhere —
// lives in the chat settings, and is read when a run is driven, so a grant
// made while a run is paused applies the moment it resumes.
// Run: node --test tests/approvals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import {
  DEFAULT_APPROVALS,
  commandGranted,
  grantsFor,
  parseApprovals,
  withGrant,
  withoutGrant,
} from '../lib/chat/approvals.ts';
import { parseChatSettings } from '../lib/chat/settings.ts';
import {
  READ_ONLY_COMMANDS,
  isReadOnlyCommand,
  shellApprovalPolicy,
} from '../lib/ai/tools/shell.ts';
import { mcpToolApproval } from '../lib/mcp/run-context.ts';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

test('a granted command matches itself and its own arguments, never more', () => {
  const prefixes = ['python3 -m http.server', 'npm test'];
  assert.equal(commandGranted('python3 -m http.server', prefixes), true);
  assert.equal(commandGranted('python3 -m http.server 8080', prefixes), true);
  assert.equal(commandGranted('  npm test -- --watch ', prefixes), true);
  assert.equal(commandGranted('python3 -m http.serverX', prefixes), false, 'a word boundary');
  assert.equal(commandGranted('python3 -m http.server; rm -rf /', prefixes), false, 'a separator');
  assert.equal(commandGranted('python3 -m http.server && cat x', prefixes), false);
  assert.equal(commandGranted('npm install', prefixes), false);
  assert.equal(commandGranted('', prefixes), false);
});

test('a grant lands in its scope and can be taken back', () => {
  const one = withGrant(DEFAULT_APPROVALS, {
    scope: 'command',
    tool: 'bash',
    command: ' python3 -m http.server 8080 ',
  });
  assert.deepEqual(one.commands, ['python3 -m http.server 8080']);
  const twice = withGrant(one, {
    scope: 'command',
    tool: 'bash',
    command: 'python3 -m http.server 8080',
  });
  assert.deepEqual(twice.commands, ['python3 -m http.server 8080'], 'no duplicates');
  const conv = withGrant(twice, {
    scope: 'conversation',
    tool: 'ssh_exec',
    conversationId: 'conv-1',
  });
  assert.deepEqual(conv.conversations, { 'conv-1': ['ssh_exec'] });
  const all = withGrant(conv, { scope: 'always', tool: 'sandbox_run' });
  assert.deepEqual(all.auto, ['sandbox_run']);
  // A command with a separator is never a grant, whatever the card was shown.
  const bad = withGrant(all, { scope: 'command', tool: 'bash', command: 'ls; rm -rf /' });
  assert.deepEqual(bad.commands, all.commands);

  assert.deepEqual(
    withoutGrant(all, { kind: 'command', value: 'python3 -m http.server 8080' }).commands,
    [],
  );
  assert.deepEqual(withoutGrant(all, { kind: 'auto', value: 'sandbox_run' }).auto, []);
  assert.deepEqual(
    withoutGrant(all, { kind: 'conversation', conversationId: 'conv-1' }).conversations,
    {},
  );
});

test('what a run in one conversation may do without asking', () => {
  const settings = withGrant(
    withGrant(DEFAULT_APPROVALS, { scope: 'conversation', tool: 'bash', conversationId: 'conv-1' }),
    { scope: 'always', tool: 'ssh_exec' },
  );
  const here = grantsFor(settings, 'conv-1');
  assert.deepEqual([...here.tools].sort(), ['bash', 'ssh_exec']);
  const elsewhere = grantsFor(settings, 'conv-2');
  assert.deepEqual(
    [...elsewhere.tools],
    ['ssh_exec'],
    'a conversation grant stays in its conversation',
  );
});

test('stored grants are bounded and cleaned on the way in', () => {
  const parsed = parseApprovals({
    auto: ['bash', 'bash', 42, 'x'.repeat(500)],
    commands: ['npm test', 'ls; rm -rf /', '', 'a'.repeat(400)],
    conversations: { 'conv-1': ['bash', 7], 'conv-2': 'nope', 'conv-3': [] },
  });
  assert.deepEqual(parsed.auto, ['bash']);
  assert.deepEqual(parsed.commands, ['npm test']);
  assert.deepEqual(parsed.conversations, { 'conv-1': ['bash'] });
  assert.deepEqual(parseApprovals(undefined), DEFAULT_APPROVALS);
  // Through the settings document, absent means none.
  assert.deepEqual(parseChatSettings({}).approvals, DEFAULT_APPROVALS);
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['conv-' + i, ['bash']]));
  assert.equal(Object.keys(parseApprovals({ conversations: many }).conversations).length, 50);
});

test('the shell policy honours a granted command, a granted tool, and nothing else', async () => {
  const ask = shellApprovalPolicy();
  assert.equal((await ask({ command: 'python3 -m http.server 8080' })).gate, 'user-approval');
  const byCommand = shellApprovalPolicy({ tools: new Set(), commands: ['python3 -m http.server'] });
  assert.equal((await byCommand({ command: 'python3 -m http.server 8080' })).gate, 'approved');
  assert.equal(
    (await byCommand({ command: 'python3 -m http.server 8080 | tee log' })).gate,
    'user-approval',
  );
  assert.equal((await byCommand({ command: 'rm -rf build' })).gate, 'user-approval');
  const byTool = shellApprovalPolicy({ tools: new Set(['bash']), commands: [] });
  assert.equal((await byTool({ command: 'rm -rf build' })).gate, 'approved');
  assert.equal((await byTool({})).gate, 'user-approval', 'an unreadable call still asks');
});

test('an unbound MCP grant never approves by id', () => {
  // Legacy grants remembered bare tool ids. An id alone is not consent: the
  // consent must bind the connector account, the approved fingerprint and the
  // scope, which lives in the MCP store, not here. mcpToolApproval maps the
  // decisions already resolved there, and ignores id-based grants entirely.
  const policy = mcpToolApproval(
    new Map([
      ['mcp__quran__search', 'auto'],
      ['mcp__quran__fetch', 'ask'],
    ]),
    { tools: new Set(['mcp__quran__search', 'mcp__quran__fetch']), commands: [] },
  );
  assert.equal(policy['mcp__quran__search'], 'approved', 'resolved to auto upstream');
  assert.equal(policy['mcp__quran__fetch'], 'user-approval', 'a grant cannot override ask');
});

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const chunks = (parts) =>
  simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 });
const call = (toolName, input) => [
  { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
];
const answer = (text) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage },
];

test('on the real agent, a granted command runs and a program with a grant runs', async () => {
  const ran = [];
  const agentWith = (approvals, steps) => {
    let step = 0;
    return buildRunAgent({
      provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
      model: new MockLanguageModelV4({ doStream: async () => ({ stream: chunks(steps[step++]) }) }),
      instructions: 'test',
      meaningModel: {},
      signal: new AbortController().signal,
      approvals,
      shell: {
        conversationId: 'conv-1',
        available: true,
        stream: async function* (request) {
          ran.push(request.command ?? request.code ?? request);
          yield { type: 'output', stream: 'stdout', data: 'ok' };
          yield { type: 'exit', exitCode: 0, truncated: false };
        },
      },
    });
  };
  const fold = async (agent) => {
    const stream = await createAgentUIStream({
      agent,
      uiMessages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    });
    let last;
    for await (const value of readUIMessageStream({ stream })) last = value;
    return last.parts.find((part) => part.type?.startsWith('tool-'));
  };
  const granted = await fold(
    agentWith({ tools: new Set(), commands: ['python3 -m http.server'] }, [
      call('bash', { command: 'python3 -m http.server 8080', description: 'Serve the page' }),
      answer('Serving.'),
    ]),
  );
  assert.notEqual(granted.state, 'approval-requested');
  assert.equal(ran.length, 1);

  const program = await fold(
    agentWith({ tools: new Set(['sandbox_run']), commands: [] }, [
      call('sandbox_run', { language: 'python', code: 'print(1)', description: 'Print one' }),
      answer('Printed.'),
    ]),
  );
  assert.notEqual(program.state, 'approval-requested', 'sandbox_run with a grant runs');

  const asked = await fold(
    agentWith({ tools: new Set(), commands: [] }, [
      call('bash', { command: 'python3 -m http.server 8080', description: 'Serve the page' }),
    ]),
  );
  assert.equal(asked.state, 'approval-requested', 'without a grant it still asks');
});

test('printing the environment is not something that runs unasked', () => {
  // `env` was on the auto-approved list, and the workbench spawned commands with
  // the whole of `process.env` — so `env` printed HIKMAH_WORKBENCH_TOKEN, the
  // workbench's entire authentication, with nobody's say-so. The spawn is
  // filtered now (workbench/src/env.ts), which is the real fix; this is the
  // second half of it, because "reads nothing that matters" was never true of a
  // command whose whole job is to print the process's secrets.
  assert.equal(isReadOnlyCommand('env'), false);
  assert.equal(isReadOnlyCommand('printenv'), false, 'and its other spelling was never listed');
  assert.ok(!READ_ONLY_COMMANDS.includes('env'));
});

test('find asks when it is told to change something', () => {
  // `find` is on the list because it reads. But `find` is also a way to run
  // arbitrary commands and to delete a tree, and neither spelling needs a
  // separator — so `find /workspace -delete` was auto-approved as a read, and
  // `-exec … {} +` slipped past the separator check too, since `+` is not one.
  assert.equal(isReadOnlyCommand('find . -name "*.ts"'), true, 'an ordinary find still runs');
  assert.equal(isReadOnlyCommand('find /workspace -type f'), true);

  for (const command of [
    'find /workspace -delete',
    'find . -name "*.log" -delete',
    'find . -exec rm -rf {} +',
    'find . -execdir touch x +',
    'find . -ok rm {} +',
    'find . -fprint /workspace/out.txt',
    'find . -fls /workspace/out.txt',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, `${command} must ask`);
  }

  // The flag has to be its own word: a file called "-delete-notes" is not one.
  assert.equal(isReadOnlyCommand('find . -name deleted'), true, 'a substring is not a flag');
});
