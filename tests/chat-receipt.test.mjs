// "Each answer shows which items were used."
//
// The Memory screen has promised that line since before there was a server to
// make it true; the receipt had no knowledge hook at all. The run now streams
// one `data-memories` part naming what the prompt carried, and the receipt
// counts it. Rendered with the real component to real markup.
// Run: node --test tests/chat-receipt.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-receipt-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { MessageParts } from './components/chat/message-parts.tsx';
      export const render = (props) => renderToStaticMarkup(createElement(MessageParts, props));
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(dir, 'render.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  alias: { '@': root },
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'silent',
});
const { render } = await import(pathToFileURL(join(dir, 'render.mjs')));

const answered = (parts) => ({
  status: 'ready',
  message: {
    id: 'm1',
    role: 'assistant',
    metadata: { model: 'a/b:free', usage: { totalTokens: 120 } },
    parts,
  },
});

const memories = (used) => ({ type: 'data-memories', id: 'memories', data: { used } });

test('the receipt says how many memories the answer drew on', () => {
  const html = render(
    answered([
      memories([
        { id: 'm-a', title: 'Language', kind: 'preference' },
        { id: 'm-b', title: 'Mumbai cap', kind: 'reference' },
      ]),
      { type: 'text', text: 'The cap is 7500.' },
    ]),
  );
  assert.match(html, /used 2 memories/);
  assert.doesNotMatch(html, /Unrecognised content/, 'the part itself renders nothing');
});

test('one memory is singular', () => {
  const html = render(
    answered([
      memories([{ id: 'm-a', title: 'Language', kind: 'preference' }]),
      { type: 'text', text: 'Ji.' },
    ]),
  );
  assert.match(html, /used 1 memory\b/);
});

test('an answer written with no memories says nothing about them', () => {
  const html = render(answered([{ type: 'text', text: 'Ji.' }]));
  assert.doesNotMatch(html, /memor/);
});

test('a turn that carried memories and said nothing is still a blank turn', () => {
  // The bookkeeping part renders nothing, so it cannot fill the hole where an
  // answer belongs — the transcript still has to account for the turn.
  const html = render(answered([memories([{ id: 'm-a', title: 'Language', kind: 'preference' }])]));
  assert.match(html, /produced nothing/);
});
