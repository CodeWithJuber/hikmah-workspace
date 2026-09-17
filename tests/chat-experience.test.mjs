import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentRunActivity,
  failureAction,
  readConversationDraft,
  transcriptMarkdown,
  writeConversationDraft,
} from '../components/chat/chat-experience.ts';

function draftStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('drafts survive a reload, stay scoped to their conversation, and clear after send', () => {
  const storage = draftStorage();
  assert.equal(writeConversationDraft(storage, 'chat/one', 'Research water', 1000), true);
  assert.equal(writeConversationDraft(storage, 'chat/two', 'Build an app', 1000), true);
  assert.equal(readConversationDraft(storage, 'chat/one', 1001), 'Research water');
  assert.equal(readConversationDraft(storage, 'chat/two', 1001), 'Build an app');
  writeConversationDraft(storage, 'chat/one', '', 1002);
  assert.equal(readConversationDraft(storage, 'chat/one', 1003), '');
  assert.equal(readConversationDraft(storage, 'chat/two', 1003), 'Build an app');
});

test('malformed, expired, and oversized drafts do not restore incorrect text', () => {
  const storage = draftStorage();
  const corruptStorage = { ...draftStorage(), getItem: () => '{invalid' };
  assert.equal(readConversationDraft(corruptStorage, 'bad', 1000), '');
  writeConversationDraft(storage, 'expired', 'old draft', 1000);
  assert.equal(readConversationDraft(storage, 'expired', 1000 + 8 * 24 * 60 * 60 * 1000), '');
  writeConversationDraft(storage, 'long', 'stale short draft', 1000);
  assert.equal(writeConversationDraft(storage, 'long', 'x'.repeat(64_001), 1001), false);
  assert.equal(readConversationDraft(storage, 'long', 1002), '');
});

test('storage denial never stops typing or turns into a broken conversation', () => {
  const blocked = {
    getItem() {
      throw new Error('Blocked');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
    removeItem() {
      throw new Error('Blocked');
    },
  };
  assert.equal(readConversationDraft(blocked, 'one'), '');
  assert.equal(writeConversationDraft(blocked, 'one', 'keep typing'), false);
  assert.equal(writeConversationDraft(blocked, 'one', ''), false);
});

test('export preserves answers, sources and comparison text, excluding private run contents', () => {
  const markdown = transcriptMarkdown([
    {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Please review this.' },
        {
          type: 'file',
          filename: 'brief.pdf',
          mediaType: 'application/pdf',
          url: 'data:application/pdf;base64,private-file-bytes',
        },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'private-reasoning' },
        {
          type: 'tool-bash',
          state: 'output-available',
          input: { secret: 'private-tool-value' },
          output: 'private-tool-output',
        },
        { type: 'text', text: 'A supported answer.' },
        {
          type: 'source-url',
          sourceId: 's1',
          title: 'Evidence',
          url: 'https://example.org/evidence',
        },
        { type: 'source-url', sourceId: 's2', title: 'Unsafe', url: 'javascript:alert(1)' },
        { type: 'data-compare', data: { text: 'The comparison answer.' } },
      ],
    },
  ]);
  assert.match(markdown, /## You\n\nPlease review this\./);
  assert.match(markdown, /Attachment: brief\.pdf/);
  assert.match(markdown, /## Hikmah\n\nA supported answer\./);
  assert.match(markdown, /https:\/\/example.org\/evidence/);
  assert.match(markdown, /The comparison answer\./);
  assert.doesNotMatch(markdown, /private-|javascript:|data:application/);
});

test('reconnection does not masquerade as retrying a provider failure', () => {
  assert.equal(failureAction('Failed to fetch'), 'reconnect');
  assert.equal(failureAction('The run could not be read.'), 'reconnect');
  assert.equal(failureAction('No API key configured'), 'configure');
  assert.equal(
    failureAction('This conversation is waiting for your answer to the question above.'),
    'reload',
  );
  assert.equal(failureAction('Provider rate limit exceeded.'), 'retry');
});

test('progress names only observed tools and never counts a failed call as completed', () => {
  const message = {
    id: 'a',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'hidden content' },
      { type: 'tool-read_file', state: 'output-available' },
      { type: 'tool-run_javascript', state: 'output-error' },
      { type: 'tool-search_web', state: 'input-available' },
    ],
  };
  assert.deepEqual(currentRunActivity(message), { label: 'Searching the web', completed: 1 });
  message.parts.push({ type: 'tool-bash', state: 'approval-requested' });
  assert.deepEqual(currentRunActivity(message), {
    label: 'Waiting for your approval',
    completed: 1,
  });
  assert.deepEqual(
    currentRunActivity({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello' }] }),
    { label: 'Waiting for the model', completed: 0 },
  );
});

test('progress uses MCP tool provenance and treats a clarification as waiting', () => {
  assert.deepEqual(
    currentRunActivity({
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'dynamic-tool', toolName: 'mcp__research__fetch_source', state: 'input-available' },
      ],
    }),
    { label: 'Using research · fetch source', completed: 0 },
  );
  assert.equal(
    currentRunActivity({
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'tool-ask_user', state: 'input-available' }],
    }).label,
    'Waiting for your answer',
  );
});
