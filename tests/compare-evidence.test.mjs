// What the compare view's "Why different?" panel shows, folded from a run's
// own stream — and which reviewed examples the panel may claim the run drew
// on. The fold never invents what the run did; these tests pin that.
// Run: node --test tests/compare-evidence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'hikmah-compare-'));
await build({
  entryPoints: [join(root, 'lib/compare/evidence.ts')],
  outfile: join(dir, 'evidence.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { createLaneFold, matchLearningExamples } = await import(
  pathToFileURL(join(dir, 'evidence.mjs'))
);

const example = (overrides) => ({
  id: 'ex-1',
  runId: 'run-1',
  conversationId: 'conv-1',
  model: 'model-a',
  provider: 'openrouter',
  status: 'approved',
  prompt: 'Deploy the Next.js app with docker to the server',
  response: 'Use the deploy script.',
  correction: null,
  effectiveResponse: 'Use the deploy script.',
  redactions: [],
  createdAt: '2026-09-20T10:00:00.000Z',
  reviewedAt: '2026-09-21T10:00:00.000Z',
  revision: 1,
  ...overrides,
});

test('accumulates text deltas in order', () => {
  const { state, apply } = createLaneFold();
  apply({ type: 'text-start', id: 't1' });
  apply({ type: 'text-delta', id: 't1', delta: 'Hello, ' });
  apply({ type: 'text-delta', id: 't1', delta: 'world.' });
  apply({ type: 'text-end', id: 't1' });
  assert.equal(state.text, 'Hello, world.');
});

test('tracks each tool from call to outcome', () => {
  const { state, apply } = createLaneFold();
  apply({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'web_search' });
  apply({ type: 'tool-input-start', toolCallId: 'c2', toolName: 'remember' });
  assert.deepEqual(
    state.tools.map((tool) => [tool.name, tool.state]),
    [
      ['web_search', 'running'],
      ['remember', 'running'],
    ],
  );
  apply({ type: 'tool-output-available', toolCallId: 'c1', output: {} });
  apply({ type: 'tool-output-error', toolCallId: 'c2', errorText: 'nope' });
  assert.deepEqual(
    state.tools.map((tool) => [tool.name, tool.state]),
    [
      ['web_search', 'done'],
      ['remember', 'error'],
    ],
  );
  apply({ type: 'tool-output-denied', toolCallId: 'c1' });
  assert.equal(state.tools[0].state, 'denied');
});

test('reads recalled memories and conversations from data-memories', () => {
  const { state, apply } = createLaneFold();
  apply({
    type: 'data-memories',
    id: 'memories',
    data: {
      used: [{ id: 'm1', title: 'Prefers concise summaries', kind: 'preference' }],
      conversations: [{ id: 'conv-9', title: 'Deploy checklist' }],
    },
  });
  assert.deepEqual(state.memories, [
    { id: 'm1', title: 'Prefers concise summaries', kind: 'preference' },
  ]);
  assert.deepEqual(state.conversations, [{ id: 'conv-9', title: 'Deploy checklist' }]);
});

test('ignores malformed data-memories rather than inventing rows', () => {
  const { state, apply } = createLaneFold();
  apply({ type: 'data-memories', id: 'memories', data: { used: [{ id: 'm1' }] } });
  apply({ type: 'data-memories', id: 'memories', data: null });
  apply({ type: 'data-memories', id: 'memories', data: 'oops' });
  assert.deepEqual(state.memories, []);
  assert.deepEqual(state.conversations, []);
});

test('captures model and token usage from message metadata', () => {
  const { state, apply } = createLaneFold();
  apply({
    type: 'start',
    messageMetadata: { model: 'model-a', usage: { inputTokens: 10, outputTokens: 5 } },
  });
  apply({
    type: 'finish',
    finishReason: 'stop',
    messageMetadata: { usage: { totalTokens: 15 } },
  });
  assert.equal(state.meta.model, 'model-a');
  assert.equal(state.meta.inputTokens, 10);
  assert.equal(state.meta.outputTokens, 5);
  assert.equal(state.meta.totalTokens, 15);
});

test('ignores non-numeric metadata instead of guessing', () => {
  const { state, apply } = createLaneFold();
  apply({
    type: 'message-metadata',
    messageMetadata: { model: 42, usage: { totalTokens: 'many' } },
  });
  assert.deepEqual(state.meta, {});
});

test('records stream errors and aborts', () => {
  const { state, apply } = createLaneFold();
  apply({ type: 'error', errorText: 'Provider timed out.' });
  assert.equal(state.error, 'Provider timed out.');
  const second = createLaneFold();
  second.apply({ type: 'abort', reason: 'cancelled' });
  assert.equal(second.state.cancelled, true);
  assert.equal(second.state.error, null);
});

test('matches a reviewed example that shares the question’s words', () => {
  const matched = matchLearningExamples('How do I deploy the Next.js app to the server?', [
    example({ id: 'ex-1' }),
    example({ id: 'ex-2', status: 'pending' }),
    example({ id: 'ex-3', prompt: 'What is the capital of France?' }),
  ]);
  assert.deepEqual(
    matched.map((item) => item.id),
    ['ex-1'],
  );
});

test('matches on the same bound the server injects with', () => {
  // shared = 2, score = 2 / (3 + 4 - 2) = 0.4 >= 0.12 -> in.
  const matched = matchLearningExamples('summarise quarterly report', [
    example({ id: 'ex-9', prompt: 'quarterly report summary guidelines' }),
  ]);
  assert.deepEqual(
    matched.map((item) => item.id),
    ['ex-9'],
  );
  // shared = 1 -> out, however strong the single word.
  const missed = matchLearningExamples('summarise quarterly report', [
    example({ id: 'ex-10', prompt: 'quarterly earnings were flat' }),
  ]);
  assert.deepEqual(missed, []);
});

test('returns the best three, highest score first', () => {
  const matched = matchLearningExamples('deploy the Next.js app with docker', [
    example({ id: 'ex-b', prompt: 'deploy docker' }),
    example({ id: 'ex-a', prompt: 'deploy the Next.js app with docker to staging' }),
    example({ id: 'ex-c', prompt: 'docker deploy notes' }),
    example({ id: 'ex-d', prompt: 'deploy the app' }),
  ]);
  assert.equal(matched.length, 3);
  assert.equal(matched[0].id, 'ex-a');
});

test('an empty or stop-word-only question matches nothing', () => {
  assert.deepEqual(matchLearningExamples('', [example()]), []);
  assert.deepEqual(matchLearningExamples('what is the', [example()]), []);
});
