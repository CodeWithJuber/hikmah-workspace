// One more step before "the model stopped without writing an answer".
//
// Small free models call a tool, read its result and emit nothing; the loop
// ends because there is no further tool call, and the owner gets the working
// with no answer and a receipt for every token. Reported from the phone with
// the card on screen and 86,336 tokens beside it. This gives the turn one more
// request with the tools withheld — and only when the turn produced nothing a
// person could read or act on.
//
// The same v7 mock shapes as tests/shell-approval.test.mjs.
// Run: node --test tests/closing-step.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';
import { withClosingStep } from '../lib/ai/closing-step.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const chunks = (parts) =>
  simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 });

const toolCall = (toolName, input) => [
  { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
];
/** What a small model does after reading the tool result: nothing at all. */
const silence = [{ type: 'finish', finishReason: { unified: 'stop' }, usage }];
const words = (text, over = usage) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: over },
];

const userTurn = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What is 2+2?' }] };

/** The main agent over a scripted model, plus a separate scripted model for
 * the closing step, which records what it was asked. */
function scenario(steps, closing, extra = {}) {
  let step = 0;
  const agent = buildRunAgent({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: chunks(steps[step++]) }) }),
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
    ...extra,
  });
  const asked = [];
  const closingModel = new MockLanguageModelV4({
    doStream: async (options) => {
      asked.push(options);
      if (closing instanceof Error) throw closing;
      return { stream: chunks(closing) };
    },
  });
  return { agent, closingModel, asked };
}

async function fold(chunkList) {
  let message;
  for await (const value of readUIMessageStream({ stream: ReadableStream.from(chunkList) }))
    message = value;
  return message;
}

async function drive(agent, closingModel, hooks = {}) {
  const source = await createAgentUIStream({
    agent,
    uiMessages: [userTurn],
    messageMetadata: ({ part }) =>
      part.type === 'finish' ? { model: 'a/b:free', usage: part.totalUsage } : undefined,
  });
  const raw = [];
  const wrapped = [];
  // Read the source once, into an array, so the same chunks can be folded both
  // with and without the closing step: the control shows the failure the fix
  // addresses.
  for await (const chunk of source) raw.push(chunk);
  for await (const chunk of withClosingStep(ReadableStream.from(raw), {
    model: closingModel,
    tools: agent.tools,
    instructions: 'test',
    messages: [userTurn],
    signal: new AbortController().signal,
    ...hooks,
  }))
    wrapped.push(chunk);
  return { raw, wrapped };
}

const text = (message) =>
  (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

test('a loop that ends on a tool result with no words gets one forced answering step', async () => {
  const { agent, closingModel, asked } = scenario(
    [toolCall('calculate', { expression: '2+2' }), silence],
    words('Four.'),
  );
  let closings = 0;
  const { raw, wrapped } = await drive(agent, closingModel, { onClosingStep: () => closings++ });

  // The control: this is what the owner saw — the working, and no answer.
  const before = await fold(raw);
  assert.equal(text(before), '', 'the loop itself wrote nothing');
  assert.ok(
    before.parts.some((part) => part.type === 'tool-calculate'),
    'after using a tool',
  );

  const after = await fold(wrapped);
  assert.equal(text(after), 'Four.', 'the closing step wrote the answer');
  assert.ok(
    after.parts.some((part) => part.type === 'tool-calculate' && part.state === 'output-available'),
    'and the tool call it was based on is still in the same message',
  );
  assert.equal(closings, 1, 'exactly one extra step');
  assert.equal(wrapped.at(-1).type, 'finish', 'the answer arrives before finish, never after');

  // The extra step is a request with the tools present and calling switched
  // off, and the history it sees includes the tool result.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolChoice?.type, 'none');
  assert.ok(
    asked[0].tools?.length > 0,
    'tool definitions travel with the tool calls in the history',
  );
  assert.ok(
    asked[0].prompt.some((m) => m.role === 'tool'),
    'the tool result is in what the closing step reads',
  );
});

test('a turn that already answered is left alone', async () => {
  const { agent, closingModel } = scenario([words('It is four.')], words('never'));
  let closings = 0;
  const { raw, wrapped } = await drive(agent, closingModel, { onClosingStep: () => closings++ });
  assert.equal(closings, 0);
  assert.deepEqual(wrapped, raw, 'the stream passes through unchanged');
});

test('a turn waiting on a person is left alone', async () => {
  // sandbox_run always asks first, so the loop stops on the request and the
  // stream ends there. Answering in its place would be answering for the owner.
  const { agent, closingModel } = scenario(
    [toolCall('sandbox_run', { language: 'python', code: 'print(1)', description: 'Print one' })],
    words('never'),
    { shell: { conversationId: 'conv', available: true, stream: async function* () {} } },
  );
  let closings = 0;
  const { raw, wrapped } = await drive(agent, closingModel, { onClosingStep: () => closings++ });
  assert.ok(
    raw.some((chunk) => chunk.type === 'tool-approval-request'),
    'the stream did pause',
  );
  assert.equal(closings, 0);
  assert.equal(wrapped.at(-1).type, 'finish');
});

test('a closing step that fails costs the turn nothing it did not already lose', async () => {
  const { agent, closingModel } = scenario(
    [toolCall('calculate', { expression: '2+2' }), silence],
    new Error('429 rate limited'),
  );
  const errors = [];
  const { wrapped } = await drive(agent, closingModel, { onError: (e) => errors.push(e) });
  assert.equal(errors.length, 1, 'the failure is reported to the log');
  assert.equal(wrapped.at(-1).type, 'finish', 'and the stream still ends properly');
  assert.equal(text(await fold(wrapped)), '', 'with the silence the run will then explain');
});

test('the answer’s recorded cost includes the step that produced it', async () => {
  const closingUsage = {
    inputTokens: { total: 3, noCache: 3 },
    outputTokens: { total: 2, text: 2 },
  };
  const { agent, closingModel } = scenario(
    [toolCall('calculate', { expression: '2+2' }), silence],
    words('Four.', closingUsage),
  );
  const { raw, wrapped } = await drive(agent, closingModel);
  const before = raw.at(-1).messageMetadata.usage;
  const after = wrapped.at(-1).messageMetadata.usage;
  assert.equal(after.inputTokens, before.inputTokens + 3);
  assert.equal(after.outputTokens, before.outputTokens + 2);
});
