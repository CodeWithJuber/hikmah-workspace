// The preview opens where the person asks, not where the run decides.
//
// PR-13: no forced right preview. The inline artifact card carries its own
// Expand control; the expanded panel is only ever opened by that control
// (chat-shell's openArtifact, a user tap). A message render must therefore
// contain the inline card and never the panel: a panel that opened on its
// own would hijack the layout the person is reading.
//
// This locks the already-correct behavior against a future change that
// auto-opens the panel when an artifact arrives — it passes against the
// current code by design, and fails the moment the panel mounts uninvited.
// Run: node --test tests/chat-artifact-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-artifact-card-'));
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

const wrotePage = {
  type: 'tool-write_file',
  toolCallId: 'w1',
  state: 'output-available',
  input: { path: 'index.html', content: '<h1>Hi</h1>' },
  output: { path: 'index.html', length: 12 },
};

test('an artifact renders inline with an Expand control, and no panel', () => {
  const html = render({
    status: 'ready',
    message: {
      id: 'm1',
      role: 'assistant',
      parts: [wrotePage, { type: 'text', text: 'Done.' }],
    },
    onArtifact: () => {},
  });
  assert.match(html, /inline-artifact/, 'the inline card is in the transcript');
  assert.match(html, /Expand/, 'with the control that opens the preview');
  assert.doesNotMatch(
    html,
    /artifact-panel/,
    'but no expanded panel opens by itself — the person places the preview',
  );
});

test('without the open handler there is no preview surface at all', () => {
  // onArtifact is what chat-shell wires to the panel; without it the card
  // has nowhere user-chosen to open, so it renders nothing.
  const html = render({
    status: 'ready',
    message: {
      id: 'm1',
      role: 'assistant',
      parts: [wrotePage, { type: 'text', text: 'Done.' }],
    },
  });
  assert.doesNotMatch(html, /inline-artifact/, 'no inline card without an opener');
  assert.doesNotMatch(html, /artifact-panel/, 'and no panel either');
});
