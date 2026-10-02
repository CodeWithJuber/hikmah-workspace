// Workstream B: memory as visible product gravity + aha moments.
//
// The annotation lines under an answer, the aha moment, and the date/growth
// helpers behind them — rendered with the real components to real markup,
// pure helpers asserted directly. Run: node --test tests/memory-annotations.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-memory-annotations-'));
await build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { createElement } from 'react';
      import {
        MemoryAnnotations,
        extractUsedMemories,
        dayWord,
        recentDayLabel,
        growthStory,
      } from './components/chat/memory-annotations.tsx';
      import { AhaMoment, describeAha } from './components/chat/aha-moment.tsx';
      export const renderAnnotations = (props) =>
        renderToStaticMarkup(createElement(MemoryAnnotations, props));
      export const renderAha = (props) =>
        renderToStaticMarkup(createElement(AhaMoment, props));
      export const helpers = {
        extractUsedMemories,
        dayWord,
        recentDayLabel,
        growthStory,
        describeAha,
      };
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
const { renderAnnotations, renderAha, helpers } = await import(
  pathToFileURL(join(dir, 'render.mjs'))
);

// A fixed "now": Monday 2026-09-28, Asia/Dubai (+04).
const NOW = new Date('2026-09-28T12:00:00+04:00');
const iso = (offsetDays, hour = 12) => {
  const d = new Date(NOW.getTime() - offsetDays * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const memoriesPart = (used) => ({
  type: 'data-memories',
  id: 'memories',
  data: { used },
});
const message = (parts) => ({ id: 'm1', role: 'assistant', parts });

// --- extractUsedMemories ---

test('extractUsedMemories reads the data-memories part', () => {
  const got = helpers.extractUsedMemories(
    message([
      memoriesPart([
        { id: 'a', title: 'Concise summaries', kind: 'preference' },
        { id: 'b', title: 'Project Falcon', kind: 'reference' },
      ]),
      { type: 'text', text: 'hi' },
    ]),
  );
  assert.deepEqual(got, [
    { id: 'a', title: 'Concise summaries', kind: 'preference' },
    { id: 'b', title: 'Project Falcon', kind: 'reference' },
  ]);
});

test('extractUsedMemories is defensive about malformed shapes', () => {
  assert.deepEqual(helpers.extractUsedMemories({}), []);
  assert.deepEqual(helpers.extractUsedMemories({ parts: 'nope' }), []);
  assert.deepEqual(helpers.extractUsedMemories(message([])), []);
  assert.deepEqual(helpers.extractUsedMemories(message([{ type: 'data-memories', id: 'x' }])), []);
  assert.deepEqual(
    helpers.extractUsedMemories(
      message([memoriesPart([{ id: '', title: 'x' }, { noId: true }, null, 'junk'])]),
    ),
    [],
  );
  // Unknown kinds fall back to reference, never crash.
  assert.deepEqual(
    helpers.extractUsedMemories(message([memoriesPart([{ id: 'a', title: 'T', kind: 'odd' }])])),
    [{ id: 'a', title: 'T', kind: 'reference' }],
  );
});

// --- dayWord / recentDayLabel ---

test('dayWord names today, yesterday, last weekday, then a short date', () => {
  assert.equal(helpers.dayWord(NOW.toISOString(), NOW), 'today');
  assert.equal(helpers.dayWord(iso(1), NOW), 'yesterday');
  // Three days back from Monday is Friday.
  assert.equal(helpers.dayWord(iso(3), NOW), 'last Friday');
  // Two weeks back is a short date, not a weekday claim.
  assert.equal(helpers.dayWord(iso(14), NOW), 'Sep 14');
  // Unreadable input falls back honestly.
  assert.equal(helpers.dayWord('not-a-date', NOW), 'recently');
});

test('recentDayLabel returns null past the window or for the future', () => {
  assert.equal(helpers.recentDayLabel(NOW.toISOString(), NOW), 'today');
  assert.equal(helpers.recentDayLabel(iso(1), NOW), 'yesterday');
  assert.equal(helpers.recentDayLabel(iso(6), NOW), 'last Tuesday');
  assert.equal(helpers.recentDayLabel(iso(7), NOW), null);
  assert.equal(helpers.recentDayLabel(iso(30), NOW), null);
  assert.equal(helpers.recentDayLabel('2026-10-05T12:00:00+04:00', NOW), null);
  assert.equal(helpers.recentDayLabel('junk', NOW), null);
  // Custom window honored.
  assert.equal(helpers.recentDayLabel(iso(10), NOW, 30), 'last Friday');
});

// --- growthStory ---

// Exact day offsets for growthStory: iso() shifts hours, which would put
// "7 days ago" inside the window. These are true N*24h offsets.
const exactIso = (offsetDays) => new Date(NOW.getTime() - offsetDays * 86_400_000).toISOString();

test('growthStory counts total and used-in-the-last-seven-days', () => {
  const story = helpers.growthStory(
    [
      { lastUsedAt: exactIso(0) },
      { lastUsedAt: exactIso(6) },
      { lastUsedAt: exactIso(7) },
      { lastUsedAt: exactIso(40) },
      { lastUsedAt: null },
    ],
    NOW,
  );
  assert.deepEqual(story, { total: 5, usedThisWeek: 2 });
});

test('growthStory ignores future and unreadable lastUsedAt', () => {
  const story = helpers.growthStory(
    [{ lastUsedAt: '2030-01-01T00:00:00Z' }, { lastUsedAt: 'junk' }],
    NOW,
  );
  assert.deepEqual(story, { total: 2, usedThisWeek: 0 });
});

// --- describeAha ---

test('describeAha celebrates a recent correction', () => {
  const got = helpers.describeAha(
    { title: 'Concise summaries', createdAt: iso(30), updatedAt: iso(3) },
    NOW,
  );
  assert.equal(got?.sourceLabel, 'Your correction from last Friday just paid off');
  assert.equal(got?.detail, 'Concise summaries');
});

test('describeAha celebrates something taught recently', () => {
  const got = helpers.describeAha(
    { title: 'Prefers bullet lists', createdAt: iso(1), updatedAt: iso(1) },
    NOW,
  );
  assert.equal(got?.sourceLabel, 'What you taught me yesterday is already helping');
  assert.equal(got?.detail, 'Prefers bullet lists');
});

test('describeAha stays quiet for older memories', () => {
  assert.equal(
    helpers.describeAha({ title: 'Old', createdAt: iso(60), updatedAt: iso(60) }, NOW),
    null,
  );
  assert.equal(
    helpers.describeAha({ title: 'Old', createdAt: iso(60), updatedAt: iso(9) }, NOW),
    null,
  );
});

// --- rendering ---

test('MemoryAnnotations renders one warm line per used memory', () => {
  const html = renderAnnotations({
    message: message([
      memoriesPart([
        { id: 'a', title: 'Concise summaries', kind: 'preference' },
        { id: 'b', title: 'Project Falcon', kind: 'reference' },
      ]),
    ]),
  });
  assert.match(html, /Used your preference: Concise summaries/);
  assert.match(html, /Used what you saved: Project Falcon/);
  assert.match(html, /aria-label="Memories this answer used"/);
  assert.doesNotMatch(html, /just paid off/);
});

test('MemoryAnnotations renders nothing when no memory was used', () => {
  assert.equal(renderAnnotations({ message: message([]) }), '');
  assert.equal(renderAnnotations({ message: message([memoriesPart([])]) }), '');
  assert.equal(renderAnnotations({ message: {} }), '');
});

test('MemoryAnnotations shows the aha moment for a recently corrected memory', () => {
  const memoryById = new Map([
    ['a', { title: 'Concise summaries', createdAt: iso(30), updatedAt: iso(3) }],
  ]);
  const seen = [];
  const html = renderAnnotations({
    message: message([memoriesPart([{ id: 'a', title: 'Concise summaries', kind: 'preference' }])]),
    memoryById,
    onJump: (id) => seen.push(id),
    now: NOW,
  });
  assert.match(html, /Your correction from last Friday just paid off/);
  assert.match(html, /Concise summaries/);
  assert.match(html, /<button/);
});

test('MemoryAnnotations is honest about a missing memory row', () => {
  const html = renderAnnotations({
    message: message([memoriesPart([{ id: 'gone', title: 'Lost one', kind: 'reference' }])]),
    memoryById: new Map(),
  });
  assert.match(html, /Used what you saved: Lost one/);
  assert.doesNotMatch(html, /just paid off/);
});

test('AhaMoment renders the delight line, button only with onJump', () => {
  const withJump = renderAha({
    sourceLabel: 'Your correction from last Tuesday just paid off',
    detail: 'Short summaries',
    onJump: () => {},
  });
  assert.match(withJump, /<button/);
  assert.match(withJump, /Your correction from last Tuesday just paid off/);
  assert.match(withJump, /Short summaries/);

  const plain = renderAha({ sourceLabel: 'Taught me today', detail: 'X' });
  assert.doesNotMatch(plain, /<button/);
  assert.match(plain, /<p/);
  assert.match(plain, /role="note"/);
});
