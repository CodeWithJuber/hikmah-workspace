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
import { answered as answeredParts } from '../lib/runs/failure.ts';

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

test('the receipt says how many earlier conversations were recalled', () => {
  const html = render(
    answered([
      {
        type: 'data-memories',
        id: 'memories',
        data: { used: [], conversations: [{ id: 'conv_a', title: 'Ghar ki baat' }] },
      },
      { type: 'text', text: 'Aap Karachi mein rehte hain, jaisa aapne pehle kaha.' },
    ]),
  );
  assert.match(html, /recalled 1 earlier conversation\b/);
  assert.doesNotMatch(html, /used \d+ memor/, 'no memories were used, so it does not say so');
});

test('the receipt says when the turn remembered something, from the tool’s own result', () => {
  const html = render(
    answered([
      {
        type: 'tool-remember',
        toolCallId: 'c1',
        state: 'output-available',
        input: { title: 'Language', quote: 'simple Urdu', kind: 'preference' },
        output: { status: 'saved', location: 'Memory' },
      },
      {
        type: 'tool-remember',
        toolCallId: 'c2',
        state: 'output-available',
        input: { title: 'Nope', quote: 'not their words', kind: 'preference' },
        output: { status: 'refused', reason: 'not verbatim' },
      },
      { type: 'text', text: 'Theek hai, yaad rakh liya.' },
    ]),
  );
  assert.match(html, /remembered 1 — see Memory/, 'the refused call is not counted');
});

const research = (data) => ({ type: 'data-research', id: 'research', data });

test('the research card lists every lane, and a finished lane opens to its finding and the pages it read', () => {
  const html = render(
    answered([
      research({
        status: 'done',
        question: 'q',
        lanes: [
          {
            question: 'What does the Hanafi school say?',
            status: 'done',
            summary: 'Not combined in time.',
            sources: ['https://example.org/hanafi'],
          },
          {
            question: 'And the Shafi‘i?',
            status: 'failed',
            error: 'Rate-limited by the provider.',
          },
        ],
        gaps: ['And the Shafi‘i?'],
      }),
      { type: 'text', text: 'Answer.' },
    ]),
  );
  assert.match(html, /Deep research · 2 lanes/);
  assert.match(html, /1 of 2 answered/);
  assert.match(html, /What does the Hanafi school say\?/);
  assert.match(html, /1 page read/);
  assert.match(html, /Not combined in time\./);
  assert.match(html, /href="https:\/\/example\.org\/hanafi"/);
  assert.match(html, /Rate-limited by the provider\./);
  assert.match(html, /Not answered: 1 sub-question/);
});

test('a research card with no words after it is still no answer', () => {
  // The card records how the turn was worked. Five lanes and no answer is no
  // answer: the run is recorded as silent and the closing step is asked to
  // write, rather than the card counting as what the person asked for.
  const parts = [
    research({
      status: 'done',
      question: 'q',
      lanes: [{ question: 'x', status: 'done', summary: 's', sources: [] }],
      gaps: [],
    }),
  ];
  assert.equal(answeredParts(parts), false);
  assert.equal(answeredParts([...parts, { type: 'text', text: 'Answer.' }]), true);
});
