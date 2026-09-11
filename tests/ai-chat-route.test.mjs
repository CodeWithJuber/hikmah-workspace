// End-to-end cover for the server-side run: the agent must stream text, call a
// tool and continue from its real result, all without a real provider.
//
// Note the v7 mock shapes: finishReason is { unified } and usage is nested
// token-detail objects. The flat v6 shapes are accepted by the type checker but
// silently prevent tool execution, which is exactly the failure this file is
// here to catch.
// Run: node --test tests/ai-chat-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const chunks = (parts) =>
  simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 });

const answer = (text) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage },
];

const callTool = (id, name, input) => [
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
];

const agentFor = (model, extra = {}) =>
  buildRunAgent({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'test/model', apiKey: 'k' },
    instructions: 'You are a test.',
    // interpret_meaning is not exercised here; the local symbolic model is only
    // touched when that tool executes.
    meaningModel: {},
    signal: new AbortController().signal,
    model,
    ...extra,
  });

async function finalMessage(stream) {
  let last;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

const textOf = (message) =>
  message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');

test('a plain answer streams back as UI message parts', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: chunks(answer('As-salamu alaykum.')) }),
  });
  const result = await agentFor(model).stream({ messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(textOf(await finalMessage(result.toUIMessageStream())), 'As-salamu alaykum.');
});

test('the agent calls a tool and continues from its real result', async () => {
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      return {
        stream: chunks(
          step === 1
            ? callTool('c1', 'calculate', { expression: '2+2*10' })
            : answer('The answer is 22.'),
        ),
      };
    },
  });
  const result = await agentFor(model).stream({
    messages: [{ role: 'user', content: 'What is 2+2*10?' }],
  });
  const message = await finalMessage(result.toUIMessageStream());

  const call = message.parts.find((p) => p.type === 'tool-calculate');
  assert.ok(call, 'the tool call should appear as a typed part');
  assert.equal(call.state, 'output-available');
  // The arithmetic is done by the tool, not asserted by the model.
  assert.equal(call.output.result, 22);
  assert.match(textOf(message), /22/);
  assert.equal(step, 2, 'the loop must continue after the tool result');
});

test('a disabled tool is not offered to the model', async () => {
  const agent = agentFor(
    new MockLanguageModelV4({ doStream: async () => ({ stream: chunks(answer('ok')) }) }),
    { disabledTools: ['calculate', 'search_web'] },
  );
  const names = Object.keys(agent.tools ?? {});
  assert.ok(!names.includes('calculate'));
  assert.ok(!names.includes('search_web'));
  assert.ok(names.includes('update_plan'), 'other tools stay available');
});

test('the step ceiling stops an unproductive loop', async () => {
  // A model that only ever calls the same tool would otherwise run forever on a
  // server with no tab to close.
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return { stream: chunks(callTool('c' + calls, 'calculate', { expression: '1+1' })) };
    },
  });
  const result = await agentFor(model, { maxSteps: 3 }).stream({
    messages: [{ role: 'user', content: 'loop' }],
  });
  await finalMessage(result.toUIMessageStream());
  assert.equal(calls, 3, 'the run must stop at the configured ceiling');
});

test('a tool that throws is reported, not swallowed', async () => {
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      return {
        stream: chunks(
          step === 1
            ? callTool('c1', 'calculate', { expression: 'not arithmetic' })
            : answer('I could not evaluate that.'),
        ),
      };
    },
  });
  const result = await agentFor(model).stream({ messages: [{ role: 'user', content: 'x' }] });
  const message = await finalMessage(result.toUIMessageStream());
  const call = message.parts.find((p) => p.type === 'tool-calculate');
  assert.equal(call.state, 'output-error');
  assert.ok(call.errorText, 'the failure reason must reach the transcript');
});
