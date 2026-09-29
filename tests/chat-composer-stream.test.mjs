// PR-12 composer and stream: attachment retry, the polite live region, and
// the no-scroll-theft stick configuration — asserted at the UI boundary.
//
// Components render to real markup with react-dom/server and the markup is
// asserted — no mocking of the design system. (Same harness shape as
// chat-ux-polish.test.mjs.)
// Run: node --test tests/chat-composer-stream.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-composer-stream-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { Conversation } from './components/ai-elements/conversation.tsx';
      import { PromptInput } from './components/ai-elements/prompt-input.tsx';
      import { AttachmentErrorAlert, RunStatusLiveRegion } from './components/chat/composer-status.tsx';
      export const render = (tag, props, children) =>
        renderToStaticMarkup(createElement(tag, props, children));
      export const renderEl = (el) => renderToStaticMarkup(el);
      export const h = createElement;
      export { Conversation, PromptInput, AttachmentErrorAlert, RunStatusLiveRegion };
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
  renderEl,
  h,
  Conversation,
  PromptInput,
  AttachmentErrorAlert,
  RunStatusLiveRegion,
} = await import(pathToFileURL(join(dir, 'render.mjs')).href);

const noop = () => {};

const attachmentAlert = (issue) =>
  h(PromptInput, { onSubmit: noop }, h(AttachmentErrorAlert, { issue, onDismiss: noop }));

// A picker validation failure offers "Try again" (reopens the file picker)
// next to Dismiss — the failure is retryable without losing the draft.
test('attachment failure offers a retry, not just a dismissal', () => {
  const html = renderEl(
    attachmentAlert({ code: 'max_file_size', message: 'All files exceed the maximum size.' }),
  );
  assert.match(html, /Try again/);
  assert.match(html, /Dismiss/);
  assert.match(html, /All files exceed the maximum size\./);
  assert.match(html, /type="button"/);
});

// An /image turn that failed server-side cannot be fixed by the file picker,
// so it only dismisses.
test('image-turn failure has no picker retry', () => {
  const html = renderEl(
    attachmentAlert({ code: 'image', message: 'The image could not be generated.' }),
  );
  assert.doesNotMatch(html, /Try again/);
  assert.match(html, /Dismiss/);
});

// The polite region announces the run edge to assistive tech: busy, then the
// settled outcome — a stop is announced as stopped, never as ready.
test('live region announces busy then the settled outcome', () => {
  const busy = render(RunStatusLiveRegion, { busy: true, outcome: false });
  assert.match(busy, /Working on your request\./);
  const stopped = render(RunStatusLiveRegion, { busy: false, outcome: 'stopped' });
  assert.match(stopped, /Response stopped\./);
  assert.doesNotMatch(stopped, /Response ready\./);
  const ready = render(RunStatusLiveRegion, { busy: false, outcome: 'ready' });
  assert.match(ready, /Response ready\./);
});

// The region is a real live region, visually hidden: status for assistive
// tech, not just the visual progress.
test('live region is polite and screen-reader-only', () => {
  const html = render(RunStatusLiveRegion, { busy: false, outcome: 'error' });
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /sr-only/);
  assert.match(html, /The request failed\./);
});

// No scroll theft: the transcript sticks to the bottom with instant (not
// animated) resizes, so incoming chunks never fight the reader's scroll —
// and use-stick-to-bottom only auto-scrolls while the reader is at the
// bottom, never while reading history.
test('conversation keeps the no-theft stick configuration', () => {
  const element = Conversation({ className: 'chat-transcript' });
  assert.equal(element.props.resize, 'instant');
  assert.equal(element.props.initial, 'smooth');
  assert.equal(element.props.role, 'log');
});
