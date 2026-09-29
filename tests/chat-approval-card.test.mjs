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
      import { grantOptions } from './components/chat/approval-card.tsx';
      export const render = (props) => renderToStaticMarkup(createElement(MessageParts, props));
      export { grantOptions };
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
const { render, grantOptions } = await import(pathToFileURL(join(dir, 'render.mjs')));

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

// PR-13: exact target/payload. A description used to hide the parameters —
// the card said what the tool claimed in words but not what it was asked
// with. Fails against the old card: it rendered no parameter block at all.
test('parameters are shown even when the tool gave a description', () => {
  const html = render({
    status: 'streaming',
    message: message([
      {
        type: 'dynamic-tool',
        toolName: 'mcp__quran__fetch_tafsir',
        toolCallId: 'call-9',
        state: 'approval-requested',
        input: { description: 'Look up the commentary', verse: '2:255', edition: 'jalalayn' },
        approval: { id: 'approval-9' },
      },
    ]),
  });
  assert.match(html, /Look up the commentary/, 'the description stays');
  assert.match(html, /2:255/, 'and the verse parameter is shown beside it');
  assert.match(html, /jalalayn/, 'and the edition parameter too');
  assert.doesNotMatch(
    html,
    /&quot;description&quot;/,
    'the description is not repeated as a parameter',
  );
});

// PR-13: unmet preconditions. An MCP tool id can never be remembered: without
// the approved definition's fingerprint there is nothing to bind, so withGrant
// parks it as unbound — honored never, shown nowhere. The old card offered
// "Always allow" anyway: a promise the settings could not keep.
test('an MCP tool offers no always-allow, and says why', () => {
  const part = {
    type: 'dynamic-tool',
    toolName: 'mcp__quran__fetch_tafsir',
    toolCallId: 'call-10',
    state: 'approval-requested',
    input: { verse: '2:255' },
    approval: { id: 'approval-10' },
  };
  const html = render({
    status: 'streaming',
    message: message([part]),
    onGrant: async () => {},
  });
  assert.doesNotMatch(html, /Always allow/, 'no remembered yes is offered');
  assert.match(
    html,
    /Only this call can be approved here/,
    'the unmet precondition is stated instead',
  );
  assert.match(html, /Allow once/, 'the one-time approval stays');
});

// PR-13: unmet preconditions. A command with a separator (or past the length
// bound) is silently left out of the settings by withGrant, so offering to
// remember it is a dead choice. Asserted on grantOptions — the pure form of
// the menu — because a closed Radix menu renders nothing to static markup.
// Fails against the old card: it offered the command grant unconditionally.
test('a command that cannot be remembered offers no command grant', () => {
  const options = grantOptions(
    {
      type: 'tool-bash',
      toolCallId: 'call-11',
      input: { command: 'echo hi; rm -rf /', description: 'Not a grantable command' },
    },
    'conv-1',
  );
  assert.ok(!options.some((option) => option.scope === 'command'), 'no command grant is offered');
  assert.ok(
    options.some((option) => option.scope === 'always'),
    'the tool-wide grants stay',
  );
});

test('a grantable command still offers the command grant', () => {
  const options = grantOptions(
    {
      type: 'tool-bash',
      toolCallId: 'call-12',
      input: { command: 'rm -rf build', description: 'Remove the build directory' },
    },
    'conv-1',
  );
  assert.deepEqual(options[0], {
    scope: 'command',
    tool: 'bash',
    command: 'rm -rf build',
  });
});

test('an MCP tool offers no grant options at all', () => {
  // withGrant would park the id as unbound — honored never, shown nowhere —
  // so the card must not offer what the settings cannot keep.
  const options = grantOptions(
    { type: 'dynamic-tool', toolName: 'mcp__quran__fetch_tafsir', input: { verse: '2:255' } },
    'conv-1',
  );
  assert.deepEqual(options, []);
});

// PR-13: cost type. The action's cost is what the system actually knows: one
// metered tool call against the run's recorded budget. Fails against the old
// card, which said nothing about cost.
test('the card names the action against the run budget when one was published', () => {
  const workflow = {
    type: 'data-workflow',
    data: {
      arm: 'default',
      budget: { maxCalls: 10, maxTokens: 1000, maxCost: 1, deadlineMs: 60000 },
      selection: { overridden: true },
    },
  };
  const html = render({
    status: 'streaming',
    message: message([workflow, bash('approval-requested')]),
  });
  assert.match(html, /One tool call against this run/, 'the cost type is named');
  assert.match(html, /1 of 10 used/, 'against the recorded figures');
});

test('no budget published means no cost line rather than an invented one', () => {
  const html = render({ status: 'streaming', message: message([bash('approval-requested')]) });
  assert.doesNotMatch(html, /One tool call against this run/);
});

// PR-13: revoked/expired approval. A card rendered where no handler can take
// the answer — the run it belongs to is not attached — must not leave live
// buttons that silently do nothing. Fails against the old card: its buttons
// stayed enabled and the tap vanished into `onApproval?.()`.
test('a card with no way to answer shows no live buttons, and says so', () => {
  const html = render({ status: 'streaming', message: message([bash('approval-requested')]) });
  assert.match(
    html,
    /can(.|&#x27;|')t be answered from here/,
    'the state is stated, not left as dead buttons',
  );
  const section = html.slice(html.indexOf('chat-approval'));
  const buttons = section.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0, 'the card still renders its buttons');
  for (const button of buttons) assert.match(button, /disabled/, `no dead buttons: ${button}`);
});
