// Research card: stages, source inspection, contradictions, resume.
//
// The card renders to real markup with react-dom/server and the markup is
// asserted — no mocking of the design system.
// Run: node --test tests/chat-research-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-chat-research-card-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { ResearchCard } from './components/chat/message-parts.tsx';
      export const render = (tag, props) => renderToStaticMarkup(createElement(tag, props));
      export { ResearchCard };
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
const { render, ResearchCard } = await import(pathToFileURL(join(dir, 'render.mjs')));

const noop = () => {};

const doneLane = {
  question: 'What is A?',
  status: 'done',
  summary: 'A is the first letter.',
  sources: [
    {
      url: 'https://example.org/a',
      excerpt: 'A is the first letter of the alphabet, the page says.',
      retrievedAt: '2026-09-30T00:00:00.000Z',
    },
  ],
};

test('stages: planning shows Plan as the current stage', () => {
  const html = render(ResearchCard, {
    view: { status: 'planning', question: 'q', lanes: [], gaps: [] },
  });
  assert.match(html, /aria-label="Research progress"/);
  assert.match(html, /chat-research-stage-current"[^>]*>.*?<span>Plan</s);
  assert.match(html, /Planning the research/);
});

test('stages: running shows Research current and Plan done', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'running',
      question: 'q',
      lanes: [{ question: 'What is A?', status: 'running', sources: [] }],
      gaps: [],
    },
  });
  const current = (html.match(/chat-research-stage-current/g) ?? []).length;
  assert.equal(current, 1, 'exactly one current stage');
  assert.match(html, /chat-research-stage-done"[^>]*>.*?<span>Plan</s);
});

test('stages: done shows every stage done and no current stage', () => {
  const html = render(ResearchCard, {
    view: { status: 'done', question: 'q', lanes: [doneLane], gaps: [] },
  });
  assert.equal((html.match(/chat-research-stage-done/g) ?? []).length, 3);
  assert.doesNotMatch(html, /chat-research-stage-current/);
});

test('stages: interrupted shows Report as the current stage', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'interrupted',
      question: 'q',
      lanes: [doneLane, { question: 'What is B?', status: 'running', sources: [] }],
      gaps: [],
      note: 'Interrupted — resume continues from the lanes already finished.',
    },
    onResume: noop,
  });
  assert.match(html, /chat-research-stage-current"[^>]*>.*?<span>Report</s);
  assert.match(html, /Research interrupted/);
});

test('source inspection: every source opens and shows what was extracted', () => {
  const html = render(ResearchCard, {
    view: { status: 'done', question: 'q', lanes: [doneLane], gaps: [] },
  });
  assert.match(html, /<a[^>]*href="https:\/\/example\.org\/a"/);
  assert.match(html, /What was extracted/);
  assert.match(html, /A is the first letter of the alphabet, the page says\./);
});

test('source inspection: a source with no extract says so honestly', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'done',
      question: 'q',
      lanes: [{ ...doneLane, sources: [{ url: 'https://example.org/b' }] }],
      gaps: [],
    },
  });
  assert.match(html, /<a[^>]*href="https:\/\/example\.org\/b"/);
  assert.match(html, /No extract was recorded for this source/);
});

test('contradictions are shown explicitly, never resolved', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'done',
      question: 'q',
      lanes: [doneLane],
      gaps: [],
      contradictions: [
        {
          claim: 'X causes Y',
          supporting: [{ lane: 'Claim about A?', sources: ['https://example.org/a'] }],
          refuting: [{ lane: 'Claim about B?', sources: ['https://example.org/b'] }],
        },
      ],
    },
  });
  assert.match(html, /Sources disagree/);
  assert.match(html, /X causes Y/);
  assert.match(html, /Supports/);
  assert.match(html, /Refutes/);
  assert.match(html, /Claim about A\?/);
  assert.match(html, /Claim about B\?/);
  // The honesty line from the disagreement contract: shown, not decided.
  assert.match(html, /does not decide which source is correct/);
});

test('no contradictions means no disagreement section', () => {
  const html = render(ResearchCard, {
    view: { status: 'done', question: 'q', lanes: [doneLane], gaps: [] },
  });
  assert.doesNotMatch(html, /Sources disagree/);
});

test('interrupted card offers resume when a handler is given', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'interrupted',
      question: 'q',
      lanes: [doneLane, { question: 'What is B?', status: 'running', sources: [] }],
      gaps: [],
      note: 'Interrupted — resume continues from the lanes already finished.',
    },
    onResume: noop,
  });
  assert.match(html, /Resume research/);
  assert.match(html, /<button/);
});

test('interrupted card shows no resume button without a handler', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'interrupted',
      question: 'q',
      lanes: [doneLane],
      gaps: [],
    },
  });
  assert.doesNotMatch(html, /Resume research/);
});

test('a finished card never offers resume', () => {
  const html = render(ResearchCard, {
    view: { status: 'done', question: 'q', lanes: [doneLane], gaps: [] },
    onResume: noop,
  });
  assert.doesNotMatch(html, /Resume research/);
});

test('a failed card with unfinished lanes offers resume', () => {
  const html = render(ResearchCard, {
    view: {
      status: 'failed',
      question: 'q',
      lanes: [{ question: 'What is A?', status: 'failed', error: 'Rate-limited.', sources: [] }],
      gaps: ['What is A?'],
    },
    onResume: noop,
  });
  assert.match(html, /Resume research/);
});
