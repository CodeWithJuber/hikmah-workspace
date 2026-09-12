/** Finding the page an answer produced.
 *
 * The existing detector reads fenced code out of the reply, which is what the
 * agent did before it had a file tool. With `write_file` available it writes
 * the file instead and fences nothing — so a detector that only reads the text
 * would find nothing, and the preview would never appear for the path the
 * agent actually takes.
 * Run: node --test tests/chat-artifact.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageArtifact } from '../lib/chat/artifact.ts';

const text = (value) => ({ type: 'text', text: value });
const wrote = (path, content, state = 'output-available') => ({
  type: 'tool-write_file',
  state,
  input: { path, content },
  output: { path, length: content.length },
});

test('a page fenced in the reply is still found', () => {
  const files = messageArtifact({
    parts: [text('Here you go:\n\n```html\n<h1>Hi</h1>\n```\n\n```css\nh1 { color: red }\n```')],
  });
  assert.equal(files['index.html'].trim(), '<h1>Hi</h1>');
  assert.equal(files['style.css'].trim(), 'h1 { color: red }');
});

test('a page written through the tool is found, which it was not before', () => {
  const files = messageArtifact({
    parts: [text('I wrote the page.'), wrote('index.html', '<h1>Written</h1>')],
  });
  assert.equal(files['index.html'], '<h1>Written</h1>');
});

test('what was written wins over what was shown', () => {
  // If the agent both wrote the file and pasted it, the written copy is the
  // one that exists on disk, so it is the one to preview.
  const files = messageArtifact({
    parts: [text('```html\n<h1>Draft</h1>\n```'), wrote('index.html', '<h1>Final</h1>')],
  });
  assert.equal(files['index.html'], '<h1>Final</h1>');
});

test('a failed write produces no preview', () => {
  assert.equal(
    messageArtifact({ parts: [wrote('index.html', '<h1>Nope</h1>', 'output-error')] }),
    null,
  );
});

test('only the three files a page is made of are collected', () => {
  const files = messageArtifact({
    parts: [wrote('index.html', '<h1>Hi</h1>'), wrote('notes.md', '# not a page')],
  });
  assert.deepEqual(Object.keys(files), ['index.html']);
});

test('without an index.html there is nothing to preview', () => {
  assert.equal(messageArtifact({ parts: [wrote('style.css', 'body{}')] }), null);
  assert.equal(messageArtifact({ parts: [text('Just an answer.')] }), null);
  assert.equal(messageArtifact({ parts: [] }), null);
});

test('an enormous file is not inlined into the preview document', () => {
  assert.equal(messageArtifact({ parts: [wrote('index.html', 'x'.repeat(80_001))] }), null);
});
