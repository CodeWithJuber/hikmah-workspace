// A conversation is named from the message that opened it. These cover the
// cases a sidebar actually meets: long questions, pasted blocks, and messages
// that carry no words at all.
// Run: node --test tests/conversation-title.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTitle } from '../lib/chat/title.ts';

const text = (value) => [{ type: 'text', text: value }];

test('a short question is the title, unchanged', () => {
  assert.equal(conversationTitle(text('How do I restart nginx?')), 'How do I restart nginx?');
});

test('a long question is cut at a word, not mid-word', () => {
  const title = conversationTitle(
    text('Explain how the durable run worker claims a queued run and why it uses RETURNING'),
  );
  assert.ok(title.length <= 61, title);
  assert.ok(title.endsWith('…'));
  assert.ok(!/\w…$/.test(title.replace(/ …$/, '')) || title.includes(' '), 'cut on a boundary');
  assert.ok(!title.includes('RETURNIN…'), 'a word is not left half-written');
});

test('a single unbroken run of characters is still cut', () => {
  // No word boundary to fall back on: a hard cut beats a title that overflows
  // its row.
  const title = conversationTitle(text('a'.repeat(200)));
  assert.equal(title.length, 61);
  assert.ok(title.endsWith('…'));
});

test('a pasted block does not bring its whitespace into the row', () => {
  assert.equal(
    conversationTitle(text('fix this:\n\n   const a = 1;\n   const b = 2;')),
    'fix this: const a = 1; const b = 2;',
  );
});

test('a message with no words has no title rather than a placeholder', () => {
  // Every image-opened conversation being called the same thing is worse than
  // the list saying plainly that this one has no name.
  assert.equal(conversationTitle([{ type: 'file', url: 'x' }]), '');
  assert.equal(conversationTitle(text('   ')), '');
  assert.equal(conversationTitle([]), '');
});

test('anything that is not a part array is survived, not thrown on', () => {
  // The parts come from the client. A title is not worth failing a send over.
  assert.equal(conversationTitle(undefined), '');
  assert.equal(conversationTitle(null), '');
  assert.equal(conversationTitle('hello'), '');
  assert.equal(conversationTitle([{ type: 'text' }, { type: 'text', text: 'kept' }]), 'kept');
});
