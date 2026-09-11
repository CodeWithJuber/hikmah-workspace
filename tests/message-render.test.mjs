// Regression cover for the chat transcript render gate.
// Run: node --test tests/message-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderMessageText } from '../lib/playground/execution.ts';

test('a streaming answer is visible before the run finishes', () => {
  assert.equal(
    shouldRenderMessageText({ role: 'assistant', text: 'Partial ans', status: 'running' }),
    true,
  );
});

test('stopping a run keeps the text the runner preserved', () => {
  // The composer, the transport and the runner all promise the partial answer
  // is kept. Gating the render on status === 'complete' made Stop blank it.
  for (const status of ['stopped', 'paused', 'error']) {
    assert.equal(
      shouldRenderMessageText({ role: 'assistant', text: 'Half an answer', status }),
      true,
      `${status} answers must stay on screen`,
    );
  }
});

test('completed and user messages render', () => {
  assert.equal(
    shouldRenderMessageText({ role: 'assistant', text: 'Done', status: 'complete' }),
    true,
  );
  assert.equal(shouldRenderMessageText({ role: 'user', text: 'Ask' }), true);
});

test('a message with no text renders nothing', () => {
  assert.equal(shouldRenderMessageText({ role: 'assistant', text: '', status: 'running' }), false);
  assert.equal(shouldRenderMessageText({ role: 'assistant', status: 'running' }), false);
});
