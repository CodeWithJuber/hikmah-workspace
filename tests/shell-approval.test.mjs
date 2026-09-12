// The workbench tools are gated, or they are not.
//
// `shellApprovalPolicy()` and the `sandbox_run` rule were both written, both
// computed on every run, and then dropped: `buildRunAgent` spread only the ssh
// and MCP policies into `toolApproval`, so neither ever reached the agent. The
// approval card the documentation promises for `bash` and always promises for
// `sandbox_run` has never appeared, and both have run unprompted since the
// workbench shipped.
//
// The same v7 mock shapes as tests/ai-approval.test.mjs; see its header.
// Run: node --test tests/shell-approval.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const chunks = (parts) =>
  simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 });

const call = (toolName, input) => [
  { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
];

/** An agent with a workbench that records what it was actually asked to run. */
function agentOver(steps) {
  const ran = [];
  let step = 0;
  return {
    ran,
    agent: buildRunAgent({
      provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
      model: new MockLanguageModelV4({ doStream: async () => ({ stream: chunks(steps[step++]) }) }),
      instructions: 'test',
      meaningModel: {},
      signal: new AbortController().signal,
      shell: {
        conversationId: 'conv-1',
        available: true,
        stream: async function* (request) {
          ran.push(request);
          yield { type: 'output', stream: 'stdout', data: 'ok' };
          yield { type: 'exit', exitCode: 0, truncated: false };
        },
      },
    }),
  };
}

const userTurn = (text) => ({ id: 'm1', role: 'user', parts: [{ type: 'text', text }] });
const toolPart = (message) => message.parts.find((part) => part.type?.startsWith('tool-'));

async function finalMessage(stream) {
  let last;
  for await (const value of readUIMessageStream({ stream })) last = value;
  return last;
}

test('a program is never run before the owner has seen it', async () => {
  // sandbox_run is documented as always asking: a program is not something
  // anyone can skim the way they can skim `ls -la`.
  const { agent, ran } = agentOver([
    call('sandbox_run', { language: 'python', code: 'print(1)', description: 'Print one' }),
  ]);
  const message = await finalMessage(
    await createAgentUIStream({ agent, uiMessages: [userTurn('run this')] }),
  );
  assert.equal(toolPart(message).state, 'approval-requested');
  assert.deepEqual(ran, [], 'nothing may reach the workbench before the answer');
});

test('a command that writes pauses before it writes', async () => {
  const { agent, ran } = agentOver([
    call('bash', { command: 'rm -rf /workspace/build', description: 'Clear the build' }),
  ]);
  const message = await finalMessage(
    await createAgentUIStream({ agent, uiMessages: [userTurn('clean up')] }),
  );
  assert.equal(toolPart(message).state, 'approval-requested');
  assert.deepEqual(ran, []);
});

test('a read-only command still runs without asking', async () => {
  // The gate is worth nothing if it prompts for everything: an owner who is
  // asked to approve `ls` twenty times approves the twenty-first without
  // reading it.
  const { agent, ran } = agentOver([
    call('bash', { command: 'ls -la /workspace', description: 'List the workspace' }),
  ]);
  const message = await finalMessage(
    await createAgentUIStream({ agent, uiMessages: [userTurn('what is in there')] }),
  );
  assert.notEqual(toolPart(message).state, 'approval-requested');
  assert.equal(ran.length, 1);
});

test('switching a workbench tool off also withdraws its gate', async () => {
  // A policy naming a tool the run does not have is a rule about nothing, and
  // the tool must be absent rather than present-and-ungated.
  const { agent } = (() => {
    const built = buildRunAgent({
      provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
      model: new MockLanguageModelV4({ doStream: async () => ({ stream: chunks([]) }) }),
      instructions: 'test',
      meaningModel: {},
      signal: new AbortController().signal,
      disabledTools: ['bash', 'sandbox_run'],
      shell: { conversationId: 'conv-1', available: true, stream: async function* () {} },
    });
    return { agent: built };
  })();
  const names = Object.keys(agent.tools ?? {});
  assert.ok(!names.includes('bash'));
  assert.ok(!names.includes('sandbox_run'));
});
