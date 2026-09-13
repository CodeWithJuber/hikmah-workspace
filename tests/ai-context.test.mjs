// Context reduction: the property that keeps a long run from being rejected by
// the provider, and from silently losing the task it was given.
// Run: node --test tests/ai-run-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSUMED_CONTEXT_TOKENS,
  CHARS_PER_TOKEN,
  historyBudget,
  reduceMessages,
} from '../lib/ai/context.ts';

const big = (n) => 'x'.repeat(n);
const conversation = () => [
  { role: 'system', content: 'You are Hikmah.' },
  { role: 'user', content: 'Build me a report on wheat prices.' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'search_web', input: {} }],
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'search_web', output: big(4000) }],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'b', toolName: 'read_webpage', input: {} }],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'b', toolName: 'read_webpage', output: big(4000) },
    ],
  },
  { role: 'assistant', content: 'Here is a draft.' },
  { role: 'user', content: 'Now add a chart.' },
];

test('a conversation within the limit is returned untouched', () => {
  const messages = conversation();
  assert.deepEqual(reduceMessages(messages, 1_000_000), messages);
});

// This test used to assert the opposite: that "the task the run was given must
// survive reduction", meaning the conversation's *first* user message was
// pinned into every request for ever. That was carried over from the browser
// agent runner, where one run had one task and pinning it stopped the agent
// drifting.
//
// A chat is not one task. On the deployed site the effect was that after a
// dozen turns on other subjects, every request still opened with the question
// asked first, and the answers read as the whole conversation stirred
// together — which is how the owner reported it. The system messages are the
// only anchor now; the current turn needs none, because it is the newest group
// and reduction always keeps at least that.
test('over the limit, the system message is kept and the opening question is not pinned', () => {
  const reduced = reduceMessages(conversation(), 2000);
  assert.equal(reduced[0].role, 'system');
  const users = reduced.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(
    !users.some((c) => typeof c === 'string' && c.includes('wheat prices')),
    'a dropped opening question must not be re-pinned at the top of the request',
  );
});

// --- what actually fits -----------------------------------------------------
//
// Every run reduced history at a flat 120,000 characters — about 30,000 tokens
// — whatever model it was talking to, while the catalogue's context_length was
// read only in the browser to draw the meter. On a 32,000-token model that is
// the whole window spent on history before the system prompt, before the tool
// schemas and before any room to answer, so the provider truncated the request
// from the front: the system prompt, where the identity rule and the Qur'an
// grounding live.

test('the budget comes from the model, not from a number that fits no model', () => {
  const small = historyBudget({ contextWindow: 8_000, instructions: 4_000, tools: 21 });
  const large = historyBudget({ contextWindow: 200_000, instructions: 4_000, tools: 21 });
  assert.ok(large > small, `${large} should exceed ${small}`);
  // An 8k model gets nowhere near the old flat 120,000 characters.
  assert.ok(small < 20_000, 'small window still got ' + small);
});

test('the system prompt and the tool schemas are reserved, not spent on history', () => {
  // A window small enough that the reserve decides the answer. Above roughly
  // 58,000 tokens the owner's own ceiling binds first, which is the previous
  // test's job.
  const bare = historyBudget({ contextWindow: 40_000, instructions: 1_000, tools: 0 });
  const loaded = historyBudget({ contextWindow: 40_000, instructions: 20_000, tools: 36 });
  assert.ok(bare - loaded >= 19_000 + 36 * 500, `${bare} vs ${loaded}`);
});

test('history never claims the whole window, so the model has room to answer', () => {
  const budget = historyBudget({ contextWindow: 32_000, instructions: 3_300, tools: 21 });
  assert.ok(
    budget < 32_000 * CHARS_PER_TOKEN,
    'the budget must leave room for the prompt, the tools and the answer',
  );
});

test('an unknown window falls back to the same figure the meter shows', () => {
  const unknown = historyBudget({ instructions: 3_300, tools: 21 });
  const stated = historyBudget({
    contextWindow: ASSUMED_CONTEXT_TOKENS,
    instructions: 3_300,
    tools: 21,
  });
  assert.equal(unknown, stated);
});

test('the owner’s own ceiling still lowers it, and never raises it', () => {
  const capped = historyBudget({
    contextWindow: 200_000,
    instructions: 1_000,
    tools: 0,
    ceiling: 5_000,
  });
  assert.equal(capped, 5_000);
  const raised = historyBudget({
    contextWindow: 8_000,
    instructions: 1_000,
    tools: 0,
    ceiling: 400_000,
  });
  assert.ok(raised < 400_000, 'a ceiling above what fits must not widen the request');
});

test('a tiny window still leaves enough to carry the previous turn', () => {
  assert.ok(historyBudget({ contextWindow: 1_000, instructions: 50_000, tools: 100 }) >= 2_000);
});

test('a tool result is never separated from the call it answers', () => {
  // A tool message whose assistant tool-call was dropped makes the request
  // invalid for most providers, which fails the whole run rather than degrading.
  const reduced = reduceMessages(conversation(), 2000);
  const open = new Set();
  for (const message of reduced) {
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content) if (part.type === 'tool-call') open.add(part.toolCallId);
    if (message.role === 'tool' && Array.isArray(message.content))
      for (const part of message.content)
        assert.ok(open.has(part.toolCallId), `orphan tool result ${part.toolCallId}`);
  }
});

test('the reader is told that history was dropped, as a record not an instruction', () => {
  const reduced = reduceMessages(conversation(), 2000);
  const note = reduced.find(
    (m) => typeof m.content === 'string' && m.content.includes('were dropped'),
  );
  assert.ok(note, 'a dropped-history note must be present');
  assert.match(note.content, /not\s+an instruction/);
});

test('the most recent turn is always retained', () => {
  const reduced = reduceMessages(conversation(), 500);
  const last = reduced.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'Now add a chart.');
});
