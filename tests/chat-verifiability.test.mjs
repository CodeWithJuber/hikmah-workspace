// Verifiable answers (PR-17): every factual claim links to its source, the
// receipt shows the exact data behind each claim, disagreements surface
// explicitly, and unsupported answers say so plainly.
//
// Layer 1: the pure verifier in lib/chat/verifiability.ts — claim extraction,
// evidence mining from the message's own tool outputs, disagreement
// admission, verdicts. Layer 2: the disagreement line parser the research
// lanes produce. Layer 3: the rendered surface (source cards with quotes,
// receipt verdict line, disagreement banner) via real markup.
// Run: node --test tests/chat-verifiability.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectEvidence,
  extractClaims,
  readDisagreements,
  verdictLine,
  verifyMessage,
} from '../lib/chat/verifiability.ts';
import { parseLaneDisagreements } from '../lib/ai/tools/deep-research.ts';

const src = (over = {}) => ({ type: 'source-url', ...over });
const SOURCES = [
  src({ url: 'https://a.example/page', title: 'Alpha' }),
  src({ url: 'https://b.example/other', title: 'Beta' }),
];
const text = (t) => ({ type: 'text', text: t });

// --- claim extraction -------------------------------------------------------

test('claims carrying a resolvable marker are cited', () => {
  const claims = extractClaims('The cap is 7500.[1] It applies in Dubai.[2]', SOURCES);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].status, 'cited');
  assert.deepEqual(claims[0].markers, [1]);
  assert.equal(claims[1].status, 'cited');
});

test('a claim with no marker is an orphan', () => {
  const claims = extractClaims('The cap is 7500.[1] Greetings from Dubai.', SOURCES);
  assert.equal(claims.length, 2);
  assert.equal(claims[1].status, 'orphan');
  assert.deepEqual(claims[1].markers, []);
});

test('a marker that resolves to no source is dangling, not cited', () => {
  const claims = extractClaims('The cap is 7500.[9]', SOURCES);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, 'dangling');
});

test('questions, headings and code fences are not claims', () => {
  const claims = extractClaims(
    '# Summary\nWhat is the cap?\n```\ncode [1]\n```\nThe cap is 7500.[1]',
    SOURCES,
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, 'cited');
});

// --- verdicts ----------------------------------------------------------------

test('a plain chat answer has no verifiability surface at all', () => {
  assert.equal(verifyMessage([text('Ji, how can I help?')]), null);
});

test('all claims cited: supported', () => {
  const report = verifyMessage([text('The cap is 7500.[1] It applies in Dubai.[2]'), ...SOURCES]);
  assert.equal(report.verdict, 'supported');
  assert.equal(report.cited, 2);
  assert.equal(report.orphans, 0);
  assert.match(verdictLine(report), /2 of 2 claims cite a source/);
});

test('an orphan claim makes the answer partial, counted honestly', () => {
  const report = verifyMessage([
    text('The cap is 7500.[1] It applies in Dubai.[2] Also it rains a lot.'),
    ...SOURCES,
  ]);
  assert.equal(report.verdict, 'partial');
  assert.equal(report.cited, 2);
  assert.equal(report.orphans, 1);
  assert.match(verdictLine(report), /2 of 3 claims cite a source/);
  assert.match(verdictLine(report), /1 claim has no source/);
});

test('research tools ran but no sources: unsupported, stated plainly', () => {
  const report = verifyMessage([
    {
      type: 'tool-search_web',
      state: 'output-available',
      input: { query: 'cap' },
      output: { results: [{ title: 'T', url: 'https://a.example', snippet: 'S' }] },
    },
    text('The cap is 7500.'),
  ]);
  assert.equal(report.verdict, 'unsupported');
  assert.match(verdictLine(report), /Unsupported by evidence/);
});

test('a search that found nothing says so explicitly', () => {
  const report = verifyMessage([
    {
      type: 'tool-search_web',
      state: 'output-available',
      input: { query: 'cap' },
      output: { results: [] },
    },
    text('I could not find the cap.'),
  ]);
  assert.equal(report.verdict, 'unsupported');
  assert.ok(report.searchedButEmpty);
  assert.match(verdictLine(report), /No sources found/);
});

test('a cited source that failed to fetch is a source-error', () => {
  const report = verifyMessage([
    text('The cap is 7500.[1]'),
    src({ url: 'https://a.example/page', title: 'Alpha' }),
    {
      type: 'tool-read_webpage',
      state: 'output-error',
      input: { url: 'https://a.example/page' },
      errorText: 'boom',
    },
  ]);
  assert.equal(report.verdict, 'source-error');
  assert.deepEqual(report.fetchFailures, ['Alpha']);
  assert.match(verdictLine(report), /could not be fetched/);
});

// --- evidence: the exact data, not just the source name -----------------------

test('a read page contributes its exact content as the quote', () => {
  const evidence = collectEvidence(
    [
      {
        type: 'tool-read_webpage',
        state: 'output-available',
        input: { url: 'https://a.example/page' },
        output: { source: 'https://a.example/page', content: 'The cap is exactly 7500 dirhams.' },
      },
    ],
    SOURCES,
  );
  assert.equal(evidence[0].provenance, 'page-read');
  assert.match(evidence[0].quote, /exactly 7500/);
  assert.equal(evidence[1].provenance, 'unfetched');
  assert.equal(evidence[1].quote, undefined);
});

test('a search snippet is quoted as a snippet, labelled honestly', () => {
  const evidence = collectEvidence(
    [
      {
        type: 'tool-search_web',
        state: 'output-available',
        input: { query: 'cap' },
        output: {
          results: [
            { title: 'Beta', url: 'https://b.example/other', snippet: 'Cap raised to 8000.' },
          ],
        },
      },
    ],
    SOURCES,
  );
  assert.equal(evidence[1].provenance, 'search-snippet');
  assert.match(evidence[1].quote, /raised to 8000/);
});

// --- disagreements: proposed by lanes, admitted by validation -----------------

const disagreementPart = (disagreements) => ({
  type: 'data-disagreement',
  id: 'disagreement',
  data: { disagreements },
});

test('a well-formed disagreement makes the answer disputed', () => {
  const report = verifyMessage([
    text('The cap is 7500.[1]'),
    ...SOURCES,
    disagreementPart([
      {
        claim: 'the visa cap amount',
        parties: [
          { source: 'https://a.example/page', says: '7500' },
          { source: 'https://b.example/other', says: '8000' },
        ],
      },
    ]),
  ]);
  assert.equal(report.verdict, 'disputed');
  assert.equal(report.disagreements.length, 1);
  assert.equal(report.disagreements[0].parties.length, 2);
  // A party the answer cites is named the way the citations name it.
  assert.equal(report.disagreements[0].parties[0].title, 'Alpha');
  assert.equal(report.disagreements[0].parties[1].title, 'Beta');
});

test('a malformed disagreement is dropped, never rendered', () => {
  // One party is not a disagreement; an empty claim says nothing.
  const dropped = readDisagreements(
    [disagreementPart([{ claim: '', parties: [{ source: 'https://a.example', says: 'x' }] }])],
    SOURCES,
  );
  assert.deepEqual(dropped, []);
  const report = verifyMessage([
    text('The cap is 7500.[1]'),
    ...SOURCES,
    disagreementPart([{ claim: '', parties: [{ source: 'https://a.example', says: 'x' }] }]),
  ]);
  assert.equal(report.verdict, 'supported');
});

// --- lane disagreement lines ---------------------------------------------------

test('lanes report disagreements in the pipe-delimited line format', () => {
  const summary =
    'The cap is 7500.\nDISAGREEMENT | the visa cap | https://a.example/page :: says 7500 | https://b.example/other :: says 8000';
  const parsed = parseLaneDisagreements(summary);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].claim, 'the visa cap');
  assert.equal(parsed[0].parties.length, 2);
  assert.equal(parsed[0].parties[0].url, 'https://a.example/page');
  assert.equal(parsed[0].parties[1].says, 'says 8000');
});

test('malformed disagreement lines are dropped, not half-parsed', () => {
  assert.deepEqual(parseLaneDisagreements('DISAGREEMENT | only a fact'), []);
  assert.deepEqual(
    parseLaneDisagreements(
      'DISAGREEMENT | fact | not-a-url :: says x | https://b.example :: says y',
    ),
    [],
  );
  assert.deepEqual(parseLaneDisagreements('no marker here'), []);
});

// --- rendered surface ----------------------------------------------------------

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-verifiability-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import { MessageParts, ResearchSourceStrip } from './components/chat/message-parts.tsx';
      import { ChatReceipt } from './components/chat/chat-receipt.tsx';
      import { DisagreementBanner } from './components/chat/verifiability.tsx';
      export const render = (tag, props) => renderToStaticMarkup(createElement(tag, props));
      export { MessageParts, ResearchSourceStrip, ChatReceipt, DisagreementBanner };
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
const { render, MessageParts, ResearchSourceStrip, ChatReceipt, DisagreementBanner } = await import(
  pathToFileURL(join(dir, 'render.mjs'))
);

const answered = (parts) => ({
  status: 'ready',
  message: {
    id: 'm1',
    role: 'assistant',
    metadata: { model: 'a/b:free', usage: { totalTokens: 120 } },
    parts,
  },
});

const partialMessage = () =>
  answered([text('The cap is 7500.[1] It applies in Dubai.[2] Also it rains a lot.'), ...SOURCES]);

test('the receipt carries the verdict line for a research answer', () => {
  const html = render(MessageParts, partialMessage());
  assert.match(html, /2 of 3 claims cite a source/);
  assert.match(html, /1 claim has no source/);
});

test('an unsupported answer is marked plainly in the receipt', () => {
  const html = render(
    MessageParts,
    answered([
      {
        type: 'tool-search_web',
        state: 'output-available',
        input: { query: 'cap' },
        output: { results: [{ title: 'T', url: 'https://a.example', snippet: 'S' }] },
      },
      text('The cap is 7500.'),
    ]),
  );
  assert.match(html, /Unsupported by evidence/);
});

test('a plain chat answer gets no verifiability line', () => {
  const html = render(ChatReceipt, {
    message: {
      id: 'm1',
      role: 'assistant',
      metadata: { model: 'a/b:free', usage: { totalTokens: 5 } },
      parts: [text('Ji.')],
    },
  });
  assert.doesNotMatch(html, /claims cite a source|Unsupported by evidence/);
});

test('source cards show the exact quote the claim rests on', () => {
  const html = render(ResearchSourceStrip, {
    messageId: 'm1',
    sources: SOURCES,
    evidence: [
      {
        index: 0,
        url: 'https://a.example/page',
        title: 'Alpha',
        quote: 'The cap is exactly 7500 dirhams.',
        provenance: 'page-read',
      },
      { index: 1, url: 'https://b.example/other', title: 'Beta', provenance: 'unfetched' },
    ],
  });
  assert.match(html, /exactly 7500 dirhams/);
  assert.match(html, /From the page/);
  assert.match(html, /not read in this run/i);
});

test('a disagreement banner names both sides', () => {
  const html = render(DisagreementBanner, {
    disagreements: [
      {
        claim: 'the visa cap amount',
        parties: [
          { source: 'https://a.example/page', says: '7500' },
          { source: 'https://b.example/other', says: '8000' },
        ],
      },
    ],
  });
  assert.match(html, /Sources disagree/);
  assert.match(html, /the visa cap amount/);
  assert.match(html, /7500/);
  assert.match(html, /8000/);
});

test('a disputed answer renders the banner above the answer', () => {
  const html = render(
    MessageParts,
    answered([
      text('The cap is 7500.[1]'),
      ...SOURCES,
      disagreementPart([
        {
          claim: 'the visa cap amount',
          parties: [
            { source: 'https://a.example/page', says: '7500' },
            { source: 'https://b.example/other', says: '8000' },
          ],
        },
      ]),
    ]),
  );
  assert.match(html, /Sources disagree/);
  assert.doesNotMatch(html, /Unrecognised content/);
});
