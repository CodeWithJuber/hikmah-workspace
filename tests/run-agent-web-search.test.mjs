// The composer's Search switch: a person asked for the web on this message.
//
// Before it existed the model searched when it felt like it, and a person who
// had switched search_web off for the conversation had no way back for one
// question. With the switch on, the search tools are offered whatever the
// conversation's switches say, and the model is told to search before it
// answers rather than answer from memory.
//
// Measured on the real agent with a mock model that records what it was asked,
// not by describing the switch.
// Run: node --test tests/run-agent-web-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
const answer = (text) => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: text },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage },
];

/** The real agent over a model that answers at once and keeps every request. */
function agentWith(options) {
  const calls = [];
  const agent = buildRunAgent({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    model: new MockLanguageModelV4({
      doStream: async (request) => {
        calls.push(request);
        return {
          stream: simulateReadableStream({
            chunks: answer('From memory.'),
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
          }),
        };
      },
    }),
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
    ...options,
  });
  return { agent, calls };
}

async function run(agent) {
  const stream = await createAgentUIStream({
    agent,
    uiMessages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'latest news?' }] }],
  });
  let last;
  for await (const value of readUIMessageStream({ stream })) last = value;
  return last;
}

test('with Search on, the search tools are offered even when switched off for the conversation', () => {
  const off = agentWith({ disabledTools: ['search_web', 'read_webpage'] });
  assert.equal('search_web' in off.agent.tools, false, 'the conversation switch still holds');
  const on = agentWith({ disabledTools: ['search_web', 'read_webpage'], webSearch: true });
  assert.ok('search_web' in on.agent.tools, 'this message asked for the web');
  assert.ok('read_webpage' in on.agent.tools, 'and for reading what it finds');
  // The switch adds two tools; it does not undo every other choice.
  assert.equal('run_javascript' in on.agent.tools, true);
});

test('with Search on, the model is told to search first; without it nothing is said', async () => {
  const on = agentWith({ webSearch: true });
  const message = await run(on.agent);
  assert.equal(on.calls.length, 1);
  assert.match(
    on.calls[0].prompt.find((message) => message.role === 'system')?.content ?? '',
    /Search on/,
    'the instructions say to search before answering',
  );
  // Told, not forced: the SDK enforces a forced tool choice by failing the
  // turn when the model answers in prose anyway, which most free models do.
  // This one did, and the answer still arrived.
  assert.notEqual(on.calls[0].toolChoice?.type, 'tool');
  assert.notEqual(on.calls[0].toolChoice?.type, 'required');
  assert.equal(message.parts.find((part) => part.type === 'text')?.text, 'From memory.');

  const off = agentWith({});
  await run(off.agent);
  assert.doesNotMatch(
    off.calls[0].prompt.find((message) => message.role === 'system')?.content ?? '',
    /Search on/,
  );
});

test('an agent whose allowlist has no search tool still searches when asked', () => {
  const { agent } = agentWith({ enabledTools: ['run_javascript'], webSearch: true });
  assert.ok('search_web' in agent.tools);
  assert.equal('search_reference' in agent.tools, false, 'only what the switch names');
});
