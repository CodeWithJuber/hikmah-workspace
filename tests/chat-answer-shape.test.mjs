// Truncated pyramid: long answers split into lead + disclosure.
// Run: node --test tests/chat-answer-shape.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAnswerLead } from '../lib/chat/answer-shape.ts';

// Boundary mirrors of the module's fold constants (kept in sync by the
// boundary tests below — the constants themselves stay module-private).
const LONG_ANSWER_CHARS = 3000;
const LEAD_TARGET_CHARS = 1200;

const para = (n, len = 300) => `Paragraph ${n}. ` + 'word '.repeat(len).trim();
const longAnswer = [
  para(1, 60),
  para(2, 60),
  para(3, 60),
  para(4, 60),
  para(5, 60),
  para(6, 60),
  para(7, 60),
  para(8, 60),
  para(9, 60),
  para(10, 60),
  para(11, 60),
  para(12, 60),
].join('\n\n');

test('long structured answer splits at a paragraph boundary', () => {
  assert.ok(longAnswer.length > LONG_ANSWER_CHARS, 'fixture is long');
  const split = splitAnswerLead(longAnswer);
  assert.ok(split !== null, 'splits');
  assert.ok(split.lead.length <= LEAD_TARGET_CHARS + 400, 'lead is bounded');
  assert.ok(split.rest.length > 0, 'rest is non-empty');
  // Reassembled (modulo trimmed blank lines) it is the same answer.
  assert.equal((split.lead + '\n\n' + split.rest).replace(/\n{3,}/g, '\n\n'), longAnswer);
});

test('short answer renders whole', () => {
  assert.equal(splitAnswerLead('A short answer.'), null);
  assert.equal(splitAnswerLead('x'.repeat(LONG_ANSWER_CHARS - 1)), null);
});

test('no blank line before the target renders whole', () => {
  assert.equal(splitAnswerLead('word '.repeat(1200)), null);
});

test('lead with an unclosed fence renders whole', () => {
  // The blank line inside the fence is the last eligible cut, so the lead
  // would end with an unclosed fence — the split must be refused.
  const text =
    para(1, 80) +
    '\n\n```python\n' +
    'x = 1\n'.repeat(100) +
    '\n' +
    'y = 2\n'.repeat(100) +
    '\n\n' +
    para(9, 400);
  assert.ok(text.length > LONG_ANSWER_CHARS, 'fixture is long');
  assert.equal(splitAnswerLead(text), null);
});

test('lead with a balanced fence splits', () => {
  const text =
    'Intro paragraph.\n\n```python\n' +
    'x = 1\n'.repeat(30) +
    '```\n\n' +
    [para(1), para(2), para(3), para(4), para(5)].join('\n\n');
  assert.ok(text.length > LONG_ANSWER_CHARS, 'fixture is long');
  const split = splitAnswerLead(text);
  assert.ok(split !== null, 'splits');
  assert.ok(split.lead.includes('```'), 'lead keeps the complete block');
});

test('empty input renders whole', () => {
  assert.equal(splitAnswerLead(''), null);
});
