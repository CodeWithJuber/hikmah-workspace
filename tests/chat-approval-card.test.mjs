// The Allow button was behind a tap nobody knew to make.
//
// The approval card lived inside the tool's Collapsible, opened with
// `defaultOpen` when the part was waiting. Radix reads that once, at mount —
// and on a live stream the SDK creates the part on `tool-input-start` and only
// later mutates the same part to `approval-requested`. So the card mounted
// closed and stayed closed; a reload, which mounts it already waiting, was the
// one case that worked, and the one case the browser check had seeded.
//
// The structural fact this asserts is the fix: the Allow button is not a
// descendant of any Collapsible, so there is no disclosure for it to be
// behind, whenever the part entered the waiting state. Rendered with the real
// component to real markup, not by reading the source.
// Run: node --test tests/chat-approval-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-approval-'));
await build({
  // One bundle holding React, the server renderer and the component, so the
  // hooks the component uses see the same React the renderer does.
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

const bash = (state, over = {}) => ({
  type: 'tool-bash',
  toolCallId: 'call-1',
  state,
  input: { command: 'rm -rf build', description: 'Remove the build directory' },
  approval: { id: 'approval-1' },
  ...over,
});

const message = (parts) => ({ id: 'm1', role: 'assistant', parts });

/** Where, in the markup, the Allow button is — and what encloses it. */
function allowButton(html) {
  const at = html.search(/<button[^>]*>\s*Allow\s*<\/button>/);
  if (at < 0) return null;
  // Every element opened before the button and not yet closed encloses it.
  // Counting opens against closes for the collapsible marker is enough here:
  // the renderer emits `data-slot="collapsible"` on the root only.
  const before = html.slice(0, at);
  const opened = (before.match(/data-slot="collapsible"/g) ?? []).length;
  return { at, insideCollapsible: opened > 0 };
}

test('a tool waiting for approval offers Allow outside any disclosure', () => {
  const html = render({ status: 'streaming', message: message([bash('approval-requested')]) });
  const button = allowButton(html);
  assert.ok(button, 'the Allow button is rendered at all');
  // Fails against the old card: it rendered inside <div data-slot="collapsible">.
  assert.equal(button.insideCollapsible, false, 'and not inside a Collapsible');
  assert.doesNotMatch(
    html,
    /data-slot="collapsible"/,
    'no tool disclosure is rendered while waiting',
  );
  assert.match(html, /Don(’|&#x27;|')t allow/, 'and the refusal beside it');
});

test('the card says what would run, where, and why — in words, then the literal command', () => {
  const html = render({ status: 'streaming', message: message([bash('approval-requested')]) });
  assert.match(html, /Run a command/);
  assert.match(html, /on the workspace machine/);
  assert.match(html, /Remove the build directory/);
  assert.match(html, /rm -rf build/);
});

test('an MCP tool names its server, not its identifier', () => {
  const part = {
    type: 'dynamic-tool',
    toolName: 'mcp__quran__fetch_tafsir',
    toolCallId: 'call-2',
    state: 'approval-requested',
    input: { verse: '2:255' },
    approval: { id: 'approval-2' },
  };
  const html = render({ status: 'streaming', message: message([part]) });
  assert.match(html, /Use fetch tafsir/);
  assert.match(html, /through the quran server/);
  assert.doesNotMatch(
    html,
    /mcp__quran__fetch_tafsir/,
    'the raw id is not what a person is asked to allow',
  );
});

test('a tool that gave no words is shown as its input rather than as an empty question', () => {
  const html = render({
    status: 'streaming',
    message: message([
      {
        type: 'tool-ssh_exec',
        toolCallId: 'call-3',
        state: 'approval-requested',
        input: { host_id: 'web-1' },
        approval: { id: 'approval-3' },
      },
    ]),
  });
  assert.match(html, /Run a command on a saved machine/);
  assert.match(html, /on web-1/);
  // No description and no command, so the input itself is what is shown.
  assert.match(html, /&quot;host_id&quot;: &quot;web-1&quot;/);
});

test('the card is shown even with the working switched off', () => {
  // A question nobody can see is a run that never finishes.
  const html = render({
    status: 'streaming',
    showActivity: false,
    message: message([bash('approval-requested')]),
  });
  assert.ok(allowButton(html), 'Allow is rendered with activity hidden');
});

test('once answered, the tool folds back into its ordinary row with the decision recorded', () => {
  const html = render({
    status: 'ready',
    message: message([
      bash('output-available', { approval: { id: 'approval-1', approved: true }, output: 'ok' }),
    ]),
  });
  assert.equal(allowButton(html), null, 'no button on a settled call');
  assert.match(html, /data-slot="collapsible"/, 'the history is a disclosure again');
  // "You allowed this." lives inside that disclosure, and a closed Radix
  // Collapsible renders its content empty on the server — so its presence is
  // not something static markup can show. The structure is; the words are the
  // Confirmation component's own contract.
  assert.match(
    html,
    /data-state="closed"/,
    'and it starts closed: the answer is what they came for',
  );
});
