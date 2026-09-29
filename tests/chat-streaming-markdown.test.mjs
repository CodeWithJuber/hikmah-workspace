// P2-12 verification, pinned as a regression test: streamdown (which
// MessageResponse wraps) parses incomplete markdown while streaming, so a
// half-arrived fenced block never flashes as raw ``` text — it renders
// immediately as a code block marked data-incomplete, with its language
// header and copy/download actions.
// Run: node --test tests/chat-streaming-markdown.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';

// Rendered exactly as MessageResponse does while streaming.
const renderStreaming = (md) =>
  renderToStaticMarkup(
    React.createElement(Streamdown, { mode: 'streaming', isAnimating: true }, md),
  );

test('incomplete fence never flashes as raw ``` text', () => {
  const html = renderStreaming('Here is the code:\n```python\ndef hello():\n    print("wor');
  assert.ok(!html.includes('```'), 'no raw fence markers in output');
  assert.ok(html.includes('data-streamdown="code-block"'), 'code block is rendered');
  assert.ok(html.includes('data-incomplete="true"'), 'block is flagged incomplete');
});

test('incomplete block still carries header with language and actions', () => {
  const html = renderStreaming('```python\ndef hello():\n    print("wor');
  assert.ok(html.includes('data-streamdown="code-block-header"'), 'header renders');
  assert.ok(html.includes('data-language="python"'), 'language label renders');
  assert.ok(html.includes('data-streamdown="code-block-actions"'), 'copy/download actions render');
});

test('mid-stream table renders without broken markup', () => {
  const html = renderStreaming('Results:\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 |');
  assert.ok(html.includes('<table'), 'table element renders');
  assert.ok(!html.includes('|---|'), 'no raw separator row leaks');
});
