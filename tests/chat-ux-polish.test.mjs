// Chat UX polish (Workstream C): empty-state onboarding, staged loading,
// follow-up chips, and the send→stop morph button.
//
// Components render to real markup with react-dom/server and the markup is
// asserted — no mocking of the design system.
// Run: node --test tests/chat-ux-polish.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-chat-ux-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { EmptyStateOnboarding } from './components/chat/empty-state-onboarding.tsx';
      import { StagedLoading, HIKMAH_PIPELINE_STEPS } from './components/chat/staged-loading.tsx';
      import { FollowUpChips } from './components/chat/follow-up-chips.tsx';
      import { SendStopButton } from './components/chat/send-stop-button.tsx';
      export const render = (tag, props) => renderToStaticMarkup(createElement(tag, props));
      export { EmptyStateOnboarding, StagedLoading, HIKMAH_PIPELINE_STEPS, FollowUpChips, SendStopButton };
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
  EmptyStateOnboarding,
  StagedLoading,
  HIKMAH_PIPELINE_STEPS,
  FollowUpChips,
  SendStopButton,
} = await import(pathToFileURL(join(dir, 'render.mjs')));

const noop = () => {};

test('empty state: first-run sells the value prop, not a blank box', () => {
  const html = render(EmptyStateOnboarding, { variant: 'first-run', onPick: noop });
  assert.match(html, /Ask anything\. Build anything\. Teach it\./);
  assert.match(html, /Show me — build a calculator/);
  assert.match(html, /data-slot="empty-state-onboarding"/);
});

test('empty state: cleared thread gets its own copy, not the new-user pitch', () => {
  const first = render(EmptyStateOnboarding, { variant: 'first-run', onPick: noop });
  const cleared = render(EmptyStateOnboarding, { variant: 'cleared', onPick: noop });
  assert.match(cleared, /A clean slate/);
  assert.match(cleared, /Ask something new/);
  assert.notEqual(first, cleared);
  assert.doesNotMatch(cleared, /Ask anything\. Build anything/);
});

test('empty state: persona cards surface the specialists with starters', () => {
  const html = render(EmptyStateOnboarding, { variant: 'first-run', onPick: noop });
  assert.match(html, /aria-label="Specialists"/);
  for (const name of ['Research', 'Code', 'Teach']) {
    assert.match(html, new RegExp(name), `missing persona card: ${name}`);
  }
  assert.match(html, /Build a calculator/);
  assert.match(html, /Compare approaches/);
  assert.match(html, /Remember this/);
});

test('empty state: first-run carries the AI disclosure and the upgrade path', () => {
  const html = render(EmptyStateOnboarding, { variant: 'first-run', onPick: noop });
  assert.match(html, /chatting with an AI/);
  assert.match(html, /Need faster answers/);
  assert.match(html, /See plans/);
  assert.match(html, /href="\/pricing"/);
});

test('empty state: one primary action plus persona starters, all real buttons', () => {
  const html = render(EmptyStateOnboarding, { variant: 'first-run', onPick: noop });
  const buttons = (html.match(/<button/g) ?? []).length;
  // 1 primary action + 6 persona starters + 1 disclosure dismiss
  assert.ok(buttons >= 8, `expected at least 8 buttons, got ${buttons}`);
});

test('staged loading: narrates the named pipeline stages', () => {
  const html = render(StagedLoading, { currentIndex: 0, defaultExpanded: true });
  for (const step of HIKMAH_PIPELINE_STEPS) {
    assert.ok(html.includes(step.label), `missing stage: ${step.label}`);
  }
  assert.match(html, /Consulting your memory/);
  assert.match(html, /role="status"/);
});

test('staged loading: stages before the current one read as done', () => {
  const html = render(StagedLoading, { currentIndex: 2, defaultExpanded: true });
  // Two completed stages get the "(done)" screen-reader note; the third is in progress.
  const done = (html.match(/\(done\)/g) ?? []).length;
  const inProgress = (html.match(/\(in progress\)/g) ?? []).length;
  assert.equal(done, 2);
  assert.equal(inProgress, 1);
});

test('staged loading: a long run stops pretending it is quick', () => {
  const html = render(StagedLoading, { currentIndex: 1, elapsedSeconds: 42 });
  assert.match(html, /Still working/);
});

test('staged loading: no stages, no markup', () => {
  assert.equal(render(StagedLoading, { steps: [], currentIndex: 0 }), '');
});

test('follow-up chips: suggestions render as choices after an answer', () => {
  const html = render(FollowUpChips, {
    suggestions: ['Explain this simpler', 'Give an example', 'What next?'],
    onSelect: noop,
  });
  assert.match(html, /Explain this simpler/);
  assert.match(html, /Give an example/);
  assert.match(html, /Keep going/);
  assert.match(html, /data-slot="follow-up-chips"/);
});

test('follow-up chips: no suggestions means no chips row at all', () => {
  assert.equal(render(FollowUpChips, { suggestions: [], onSelect: noop }), '');
});

test('follow-up chips: loading shows placeholders, never a dead gap', () => {
  const html = render(FollowUpChips, { suggestions: [], onSelect: noop, loading: true });
  assert.match(html, /data-slot="follow-up-chips"/);
});

test('send-stop button: idle is a send button', () => {
  const html = render(SendStopButton, { state: 'idle', onSend: noop, onStop: noop });
  assert.match(html, /aria-label="Send message"/);
});

test('send-stop button: streaming morphs into stop', () => {
  const html = render(SendStopButton, { state: 'streaming', onSend: noop, onStop: noop });
  assert.match(html, /aria-label="Stop response"/);
});

test('send-stop button: sending cannot be pressed twice', () => {
  const html = render(SendStopButton, { state: 'sending', onSend: noop, onStop: noop });
  assert.match(html, /disabled/);
  assert.match(html, /aria-label="Sending message"/);
});

test('no hardcoded colours in the new components', async () => {
  const { readFileSync } = await import('node:fs');
  const hex = /#[0-9a-fA-F]{3,8}\b|rgb(a?)\s*\(|oklch\s*\(/;
  for (const file of [
    'components/chat/empty-state-onboarding.tsx',
    'components/chat/staged-loading.tsx',
    'components/chat/follow-up-chips.tsx',
    'components/chat/send-stop-button.tsx',
  ]) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(!hex.test(source), `${file} must use design tokens, not hardcoded colours`);
  }
});
