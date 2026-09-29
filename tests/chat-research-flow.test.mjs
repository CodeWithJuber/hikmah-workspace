// Chat research flow (Flows 2, 3, 5, 6): the model gate card, the agent
// picker button, the inline artifact caption and sandbox, and the research
// answer's source strip + mini follow-up composer.
//
// Components render to real markup with react-dom/server and the markup is
// asserted — no mocking of the design system.
// Run: node --test tests/chat-research-flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-chat-research-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { ConnectModelCard } from './components/chat/connect-model.tsx';
      import { AgentPicker } from './components/chat/agent-picker.tsx';
      import { InlineArtifact } from './components/kernel/artifact.tsx';
      import { ResearchSourceStrip, MiniFollowUpComposer } from './components/chat/message-parts.tsx';
      export const render = (tag, props) => renderToStaticMarkup(createElement(tag, props));
      export { ConnectModelCard, AgentPicker, InlineArtifact, ResearchSourceStrip, MiniFollowUpComposer };
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
const {
  render,
  ConnectModelCard,
  AgentPicker,
  InlineArtifact,
  ResearchSourceStrip,
  MiniFollowUpComposer,
} = await import(pathToFileURL(join(dir, 'render.mjs')));

const noop = () => {};

test('model gate: free first, key second — never a wall', () => {
  const html = render(ConnectModelCard, { onUseFree: noop, onOpenSettings: noop });
  assert.match(html, /Try it free now/);
  assert.match(html, /Add my own key/);
  assert.match(html, /no key needed/);
  const buttons = (html.match(/<button/g) ?? []).length;
  assert.equal(buttons, 2, `expected exactly 2 choices, got ${buttons}`);
});

test('agent picker: the composer shows a specialists button', () => {
  const html = render(AgentPicker, { onAgent: noop, onOpenAgents: noop });
  assert.match(html, /aria-label="Specialists"/);
  // Closed by default: the sheet is not in the markup until it opens.
  assert.doesNotMatch(html, /role="dialog"/);
});

test('inline artifact: the caption explains what was built', () => {
  const html = render(InlineArtifact, {
    files: { 'index.html': '<h1>Hi</h1>' },
    caption: 'A one-page site for the demo.',
    onOpen: noop,
  });
  assert.match(html, /A one-page site for the demo\./);
  assert.match(html, /inline-artifact-caption/);
});

test('inline artifact: no caption means no caption markup', () => {
  const html = render(InlineArtifact, { files: { 'index.html': '<h1>Hi</h1>' }, onOpen: noop });
  assert.doesNotMatch(html, /inline-artifact-caption/);
});

test('inline artifact: the preview always runs scripted and sandboxed', () => {
  const html = render(InlineArtifact, { files: { 'index.html': '<h1>Hi</h1>' }, onOpen: noop });
  assert.match(html, /sandbox="allow-scripts"/);
  // The Run/Stop toggle is gone: there is no second button besides Expand.
  assert.doesNotMatch(html, /Stop preview/);
});

test('research source strip: cards keep the citation anchor ids', () => {
  const sources = [
    { type: 'source-url', url: 'https://example.com/a', title: 'Example A' },
    { type: 'source-document', title: 'Doc B' },
  ];
  const html = render(ResearchSourceStrip, { messageId: 'm1', sources });
  assert.match(html, /chat-source-strip/);
  // The ids the citation pills link to (sourceAnchorId): one per card.
  assert.match(html, /id="cite-m1-0"/);
  assert.match(html, /id="cite-m1-1"/);
  assert.match(html, /Example A/);
  assert.match(html, /Doc B/);
  // The URL card is a real link with its host labelled; the document card is
  // a plain card, never a link to nowhere.
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /example\.com/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

test('research source strip: index numbers run in first-mention order', () => {
  const sources = [
    { type: 'source-url', url: 'https://example.com/a', title: 'Example A' },
    { type: 'source-url', url: 'https://other.org/b', title: 'Other B' },
  ];
  const html = render(ResearchSourceStrip, { messageId: 'm2', sources });
  const first = html.indexOf('>1<');
  const second = html.indexOf('>2<');
  assert.ok(first !== -1 && second !== -1 && first < second);
});

test('mini follow-up composer: a labelled input and a gated send', () => {
  const html = render(MiniFollowUpComposer, { onSubmit: noop });
  assert.match(html, /aria-label="Ask a follow-up"/);
  assert.match(html, /chat-mini-followup/);
  // Empty on first paint: the send button starts disabled.
  assert.match(html, /disabled/);
});

test('no hardcoded colours in the research flow components', async () => {
  const { readFileSync } = await import('node:fs');
  const hex = /#[0-9a-fA-F]{3,8}\b|rgb(a?)\s*\(|oklch\s*\(/;
  for (const file of [
    'components/chat/connect-model.tsx',
    'components/chat/agent-picker.tsx',
    'components/chat/message-parts.tsx',
    'components/kernel/artifact.tsx',
  ]) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, hex, `${file} hardcodes a colour`);
  }
});
