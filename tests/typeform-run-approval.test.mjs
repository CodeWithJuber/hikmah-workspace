import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
function fixture(options = {}) {
  const calls = [];
  let step = 0;
  const chunks = [
    [
      {
        type: 'tool-call',
        toolCallId: 'tf1',
        toolName: 'typeform_read_responses',
        input: '{"formId":"survey1"}',
      },
      { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
    ],
    [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'The authorized survey page is empty.' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop' }, usage },
    ],
  ];
  return {
    calls,
    agent: buildRunAgent({
      provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture', apiKey: 'test-key' },
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: chunks[step++],
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
          }),
        }),
      }),
      instructions: 'Analyze the survey if permitted.',
      meaningModel: {},
      signal: new AbortController().signal,
      typeform: {
        forms: async () => ({
          items: [{ id: 'survey1', title: 'Survey' }],
          page: 1,
          pageCount: 1,
          total: 1,
        }),
        responses: async (formId) => {
          calls.push(formId);
          return {
            form: { id: formId, title: 'Survey' },
            items: [],
            total: 0,
            nextBefore: null,
            note: 'Synthetic test data.',
          };
        },
      },
      ...options,
    }),
  };
}
async function answer(agent) {
  const stream = await createAgentUIStream({
    agent,
    uiMessages: [
      { id: 'user1', role: 'user', parts: [{ type: 'text', text: 'Summarize survey1.' }] },
    ],
  });
  let last;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

test('respondent data is never fetched before the person grants access to the model', async () => {
  const { agent, calls } = fixture();
  const message = await answer(agent);
  assert.equal(
    message.parts.find((part) => part.type === 'tool-typeform_read_responses')?.state,
    'approval-requested',
  );
  assert.deepEqual(calls, []);
});

test('a remembered permission executes the same bounded account-scoped response tool', async () => {
  const { agent, calls } = fixture({
    approvals: { tools: new Set(['typeform_read_responses']), commands: [] },
  });
  const message = await answer(agent);
  assert.deepEqual(calls, ['survey1']);
  assert.equal(
    message.parts.find((part) => part.type === 'tool-typeform_read_responses')?.state,
    'output-available',
  );
});

test('unattended tasks cannot acquire respondent data even with a remembered grant', () => {
  const { agent } = fixture({
    unattended: true,
    approvals: { tools: new Set(['typeform_read_responses']), commands: [] },
  });
  assert.equal('typeform_read_responses' in agent.tools, false);
  assert.equal('typeform_list_forms' in agent.tools, true);
});

test('missing integration or a disabled tool does not advertise working Typeform access', () => {
  const absent = fixture({ typeform: undefined }).agent;
  assert.equal('typeform_list_forms' in absent.tools, false);
  assert.equal('typeform_read_responses' in absent.tools, false);
  const disabled = fixture({ disabledTools: ['typeform_read_responses'] }).agent;
  assert.equal('typeform_read_responses' in disabled.tools, false);
});
