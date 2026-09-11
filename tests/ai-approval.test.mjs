// A command the owner has not pre-approved pauses the run. This covers the whole
// round trip, because the half that was missing looked fine from the server
// side: the model asked, and nothing ever answered.
//
// Note the v7 mock shapes: finishReason is { unified } and usage is nested
// token-detail objects. The flat v6 shapes type-check and silently prevent tool
// execution — see tests/ai-chat-route.test.mjs.
// Run: node --test tests/ai-approval.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const chunks = (parts) =>
  simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 });

const sshCall = (command, description) => [
  {
    type: 'tool-call',
    toolCallId: 'c1',
    toolName: 'ssh_exec',
    input: JSON.stringify({ host_id: 'h1', command, description }),
  },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
];

const answer = (text) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage },
];

const host = (autoApprove = null) => ({
  id: 'h1',
  user_id: 'u1',
  name: 'prod',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  auth_kind: 'password',
  fingerprint: 'a'.repeat(64),
  auto_approve: autoApprove,
  created_at: '',
  updated_at: '',
  last_used_at: null,
});

/** An agent whose only gated tool is ssh_exec, over a workbench that never runs. */
function agentOver({ hosts, steps }) {
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
      ssh: {
        listHosts: () => hosts,
        credentialFor: async () => ({ type: 'password', password: 'secret' }),
        stream: async function* (request) {
          ran.push(request.command);
          yield { type: 'output', stream: 'stdout', data: 'done' };
          yield { type: 'exit', exitCode: 0, truncated: false, fingerprint: 'a'.repeat(64) };
        },
      },
    }),
  };
}

/** Fold a stream into its final message, the way the client does.
 *
 * A resumed run continues the assistant message that was paused rather than
 * starting a new one, so that message has to be handed back in or the tool
 * result and the text that follows it land nowhere. */
async function finalMessage(stream, message) {
  let last = message;
  for await (const value of readUIMessageStream({ stream, message })) last = value;
  return last;
}

const userTurn = (text) => ({ id: 'm1', role: 'user', parts: [{ type: 'text', text }] });
const toolPart = (message) => message.parts.find((part) => part.type?.startsWith('tool-'));

/** Answer a pending approval the way the Confirmation card does. */
const respond = (message, approved) => ({
  ...message,
  parts: message.parts.map((part) =>
    part.state === 'approval-requested'
      ? { ...part, state: 'approval-responded', approval: { ...part.approval, approved } }
      : part,
  ),
});

test('a command outside the allowlist pauses, and the card has something to show', async () => {
  const { agent, ran } = agentOver({
    hosts: [host()],
    steps: [sshCall('systemctl restart nginx', 'Restart nginx to pick up the new config')],
  });
  const message = await finalMessage(
    await createAgentUIStream({ agent, uiMessages: [userTurn('restart nginx')] }),
  );
  const part = toolPart(message);
  assert.equal(part.state, 'approval-requested');
  assert.ok(part.approval?.id, 'the client needs an id to answer with');
  assert.match(part.input.description, /Restart nginx/, 'the card needs words for a person');
  assert.equal(part.input.command, 'systemctl restart nginx');
  assert.deepEqual(ran, [], 'nothing may reach the workbench before the answer');
});

test("a command on the owner's own allowlist runs without pausing", async () => {
  const { agent, ran } = agentOver({
    hosts: [host('["uptime"]')],
    steps: [sshCall('uptime', 'Check load'), answer('Load is low.')],
  });
  const message = await finalMessage(
    await createAgentUIStream({ agent, uiMessages: [userTurn('check load')] }),
  );
  assert.deepEqual(ran, ['uptime']);
  assert.equal(toolPart(message).state, 'output-available');
});

test('answering yes lets the run continue and the command actually run', async () => {
  // This is the path that did not work: the server asked, and there was no way
  // for an answer to come back.
  const asked = await finalMessage(
    await createAgentUIStream({
      agent: agentOver({
        hosts: [host()],
        steps: [sshCall('systemctl restart nginx', 'Restart nginx')],
      }).agent,
      uiMessages: [userTurn('restart nginx')],
    }),
  );

  const resumed = agentOver({ hosts: [host()], steps: [answer('Restarted nginx.')] });
  const message = await finalMessage(
    await createAgentUIStream({
      agent: resumed.agent,
      uiMessages: [userTurn('restart nginx'), respond(asked, true)],
    }),
    respond(asked, true),
  );
  assert.deepEqual(resumed.ran, ['systemctl restart nginx'], 'the approved command must run');
  assert.match(message.parts.find((part) => part.type === 'text').text, /Restarted nginx/);
});

test('answering no denies the command rather than leaving the run stuck', async () => {
  const asked = await finalMessage(
    await createAgentUIStream({
      agent: agentOver({
        hosts: [host()],
        steps: [sshCall('rm -rf /srv', 'Clear the service directory')],
      }).agent,
      uiMessages: [userTurn('clear /srv')],
    }),
  );

  const resumed = agentOver({ hosts: [host()], steps: [answer('I did not run that.')] });
  const message = await finalMessage(
    await createAgentUIStream({
      agent: resumed.agent,
      uiMessages: [userTurn('clear /srv'), respond(asked, false)],
    }),
    respond(asked, false),
  );
  assert.deepEqual(resumed.ran, [], 'a declined command must never reach the workbench');
  assert.equal(toolPart(message).state, 'output-denied');
});
