import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTask } from '../lib/agentic/preflight.ts';

test('preflight asks for missing scope on vague requests', () => {
  const result = assessTask('make it better');
  assert.equal(result.shouldAsk, true);
  assert.ok(result.questions.length > 0);
  assert.equal(result.risk, 'high');
});

test('preflight stays quiet for a concrete task', () => {
  const result = assessTask(
    'In the chat composer, fix the attachment button so it opens the file picker and add a passing UI test.',
  );
  assert.equal(result.shouldAsk, false);
  assert.ok(['low', 'medium'].includes(result.risk));
  assert.equal(result.missing.includes('output'), false);
});
