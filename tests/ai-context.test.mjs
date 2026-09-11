// Context reduction: the property that keeps a long run from being rejected by
// the provider, and from silently losing the task it was given.
// Run: node --test tests/ai-run-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceMessages } from '../lib/ai/context.ts';

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

test('over the limit, the system message and original request are kept', () => {
  const reduced = reduceMessages(conversation(), 2000);
  assert.equal(reduced[0].role, 'system');
  const users = reduced.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(
    users.some((c) => typeof c === 'string' && c.includes('wheat prices')),
    'the task the run was given must survive reduction',
  );
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
